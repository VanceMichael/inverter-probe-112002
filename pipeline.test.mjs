import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConsumerView } from './lib/consumer.mjs';
import { IngestPipeline } from './lib/pipeline.mjs';
import { start } from './source-server.mjs';

function deterministicClock() {
  let minute = 9 * 60;
  return () => {
    const stamp = new Date(`2026-11-20T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.000Z`);
    minute += 1;
    return stamp;
  };
}

async function runStages() {
  const { server, url } = await start();
  try {
    const pipeline = new IngestPipeline('储能电站A', { clock: deterministicClock() });
    pipeline.connect(url);
    const consumer = new ConsumerView(pipeline);
    const invalidations = [];
    consumer.on('invalidation', (event) => invalidations.push(event));
    for (let stage = 1; stage <= 4; stage += 1) {
      await pipeline.advanceStage(stage);
      consumer.sync();
    }
    return { pipeline, consumer, invalidations };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('重放记录按 origin 归并为同一物理样本，不按新柜倍率双算', async () => {
  const { pipeline } = await runStages();
  const alias = pipeline.store.findObservation('archive-2');
  const canonical = pipeline.store.findObservation('archive-1');
  assert.equal(alias.status, 'replay-alias');
  assert.equal(alias.physicalSample, 'DA1');
  assert.equal(canonical.status, 'released');
  assert.equal(canonical.physicalSample, 'DA1');

  // 08:52 落在 Old 柜 [00:00,09:00)，按当时接线 scale=2 解释，而非 New 柜 scale=3
  const trace = pipeline.store.activeTrace('DA1');
  assert.equal(trace.reading, 980 * 2);
  assert.equal(trace.basis.scale, 2);
  assert.equal(trace.basis.point, '逆变出口');
  assert.equal(trace.basis.wireRecord, 'wiring-1');
  // 入站身份与现场/接收时刻全部留痕
  assert.equal(trace.inbound.cabinet, 'Old');
  assert.equal(trace.recordKey, 'archive-1');
  assert.equal(trace.exportedAt, '09:20');
  assert.match(trace.receivedAt, /^2026-11-20T/);
});

test('没有适用接线的通道保持挂起，接线补登记后可恢复且不影响同站其他通道', async () => {
  const { pipeline, consumer } = await runStages();
  const n3 = pipeline.store.findObservation('live-3');
  assert.equal(n3.status, 'suspended');
  assert.equal(n3.physicalSample, null);

  const coverage08 = consumer.confirmedCoverage('New', '08');
  assert.equal(coverage08.confirmed.length, 0);
  assert.ok(coverage08.suspended.some((slot) => slot.start === '09:07'));
  assert.equal(coverage08.complete, false);

  // 补登记 New|08 接线后，挂起样本转为有效释出；04 通道覆盖不受影响
  const before04 = JSON.stringify(consumer.confirmedCoverage('New', '04').confirmed);
  pipeline.ingestRecord('wire', 'wiring-8', {
    cabinet: 'New', channel: '08', point: '并网侧',
    range: ['09:00', '24:00'], scale: 1, direction: -1, revision: 1,
  });
  consumer.sync();
  assert.equal(pipeline.store.findObservation('live-3').status, 'released');
  const unblocked = pipeline.store.events.find((event) => event.type === 'unblocked');
  assert.ok(unblocked);
  assert.equal(unblocked.sample, 'N3');
  assert.equal(JSON.stringify(consumer.confirmedCoverage('New', '04').confirmed), before04);
});

test('接线修订推翻已释出区间：先带事件失效，再按新依据重释出', async () => {
  const { pipeline, invalidations } = await runStages();
  assert.equal(invalidations.length, 2);
  for (const event of invalidations) {
    assert.equal(event.reason, 'wiring-revision');
    assert.equal(event.interval[0], '09:00');
    assert.equal(event.interval[1], '24:00');
    assert.equal(event.previousBasis.point, '逆变出口');
    assert.equal(event.newBasis.point, '并网侧');
    assert.equal(event.newBasis.revision, 2);
    assert.ok(event.recordKey.startsWith('live-'));
  }

  // 修订后 N1/N2 只在并网侧可见，逆变出口序列不再包含它们
  const grid = pipeline.series('并网侧');
  assert.deepEqual(grid.map((item) => item.sample), ['N1', 'N2']);
  assert.equal(grid[0].reading, 14 * 4);
  assert.equal(grid[0].direction, -1);
  assert.equal(grid[0].revision, 2);
  assert.deepEqual(pipeline.series('逆变出口').map((item) => item.sample), ['DA1']);

  // 旧痕迹保留为 withdrawn，可追溯到具体接线记录
  const release = pipeline.store.findRelease('N1');
  assert.equal(release.traces.length, 2);
  assert.equal(release.traces[0].status, 'withdrawn');
  assert.equal(release.traces[0].withdrawnReason, 'wiring-revision');
  assert.equal(release.traces[1].status, 'active');
});

test('修订使连续性暂时倒退：逆变出口在换接点后无有效数据', async () => {
  const { pipeline } = await runStages();
  const runs = pipeline.pointRuns('逆变出口');
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].samples, ['DA1']);
  assert.equal(runs[0].channel, 'Old|04');
});

test('表计不连续且底数缺失：跨换接点差值不得当发电量', async () => {
  const { pipeline } = await runStages();
  const report = pipeline.energy('逆变出口', ['08:45', '09:30']);
  assert.equal(report.splice.allowed, false);
  assert.equal(report.splice.reason, 'meter-not-continuous');
  assert.equal(report.splice.cutoverId, 'CO4');
  assert.equal(report.blockedBoundaries.length, 1);
  const blocked = report.blockedBoundaries[0];
  assert.equal(blocked.from, 'DA1');
  assert.equal(blocked.to, null); // N1 已改属并网侧，逆变出口无对侧样本
  assert.match(blocked.note, /不得作为发电量/);
  assert.equal(report.totalMagnitude, 0);
});

test('seq 空洞不能证明缺测；保存期底数区分不可恢复与待补', async () => {
  const { consumer } = await runStages();
  // New|04 有 09:06、09:12 两个点，09:07 是 08 通道；seq 93 空洞不产生显式空档
  const new04 = consumer.confirmedCoverage('New', '04');
  assert.ok(new04.confirmed.some((slot) => slot.start === '09:06' && slot.end === '09:07'));
  assert.ok(new04.confirmed.some((slot) => slot.start === '09:12' && slot.end === '09:13'));
  assert.ok(new04.pending.some((slot) => slot.start === '09:07' && slot.end === '09:12'));
  assert.equal(new04.unrecoverable.length, 0);
  assert.equal(new04.complete, false);

  const old04 = consumer.confirmedCoverage('Old', '04', ['00:00', '12:00']);
  assert.ok(old04.unrecoverable.some((slot) => slot.start === '00:00' && slot.end === '08:45'));
  assert.equal(old04.floor.oldest, '08:45');
  assert.ok(old04.confirmed.some((slot) => slot.start === '08:52'));
  assert.equal(old04.complete, false);
});

test('检修补票只列保存期内缺失时段，已覆盖/挂起/不可恢复均不重取', async () => {
  const { consumer } = await runStages();
  const ticket = consumer.backfillTicket('Old', '04', ['00:00', '12:00']);
  assert.equal(ticket.fetchScope, 'missing-only');
  assert.ok(ticket.slots.every((slot) => slot.start >= 8 * 60 + 45));
  assert.ok(!ticket.slots.some((slot) => slot.start === 0));
  // 08:52 已覆盖，不在补票中
  assert.ok(!ticket.slots.some((slot) => slot.start === '08:52'));
});

test('现场校验表确认的空档与暂时无法补齐分开表达', async () => {
  const { pipeline, consumer } = await runStages();
  pipeline.store.addExplicitGap('New', '04', ['10:00', '10:30'], { verifiedBy: '校验表-7' });
  const coverage = consumer.confirmedCoverage('New', '04', ['09:00', '11:00']);
  assert.ok(coverage.explicitEmpty.some((slot) => slot.start === '10:00' && slot.end === '10:30'));
  assert.ok(coverage.pending.some((slot) => slot.start === '09:13'));
  // 显式空档本身不阻断完整性判定，pending 仍然阻断
  assert.equal(coverage.complete, false);
});

test('失效通知可定位到事件与区间，且只暴露当前有效释出', async () => {
  const { consumer } = await runStages();
  const feed = consumer.invalidationFeed();
  assert.ok(feed.every((event) => event.type === 'invalidated' && event.newBasis && event.previousBasis));
  const samples = new Set(feed.map((event) => event.sample));
  assert.deepEqual([...samples].sort(), ['N1', 'N2']);
  assert.ok(consumer.currentSeries('逆变出口').every((item) => item.revision === 1));
  assert.ok(consumer.currentSeries('并网侧').every((item) => item.revision === 2));
});
