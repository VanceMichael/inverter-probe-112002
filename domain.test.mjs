import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IngestPipeline } from './lib/pipeline.mjs';
import { SourceClient } from './lib/source-client.mjs';
import { start } from './source-server.mjs';

function clockAt(startMinute = 9 * 60) {
  let minute = startMinute;
  return () => {
    const stamp = new Date(`2026-11-20T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.000Z`);
    minute += 1;
    return stamp;
  };
}

// 构造一条带连续证明与双底数的换接链路。
function buildContinuousCase() {
  const pipeline = new IngestPipeline('储能电站B', { clock: clockAt() });
  const wire = (record, payload) => pipeline.ingestRecord('wire', record, payload);
  wire('w-a', { cabinet: 'Old', channel: '01', point: '关口表', range: ['00:00', '09:00'], scale: 2, direction: 1, revision: 1 });
  wire('w-b', { cabinet: 'New', channel: '01', point: '关口表', range: ['09:00', '24:00'], scale: 5, direction: 1, revision: 1 });
  pipeline.ingestRecord('cutover', 'c-1', {
    id: 'CO1', point: '关口表', time: '09:00', continuous: true, base: [100, 20],
  });
  // 旧侧 08:00 累计 90 脉冲；新侧 09:30 累计 24 脉冲。
  pipeline.ingestRecord('sample', 's-1', {
    cabinet: 'Old', channel: '01', sample: 'A1', measured: '08:00',
    exported: '08:10', unit: 'pulse', cumulative: 90, quality: 'good',
  });
  pipeline.ingestRecord('point', 'p-1', {
    cabinet: 'New', channel: '01', seq: 1, sample: 'B1', measured: '09:30',
    unit: 'pulse', cumulative: 24, quality: 'good',
  });
  return pipeline;
}

test('连续计量且双底数齐全时允许跨换接拼接，按各自倍率平移后做差', () => {
  const pipeline = buildContinuousCase();
  const decision = pipeline.wiring.evaluateCutover('关口表');
  assert.equal(decision.allowed, true);

  const report = pipeline.energy('关口表', ['08:00', '10:00']);
  assert.equal(report.splice.allowed, true);
  assert.equal(report.blockedBoundaries.length, 0);
  const cross = report.increments.find((item) => item.kind === 'cross-cutover');
  assert.ok(cross);
  // 旧侧到底数：(100-90)*2=20；新侧离底数：(24-20)*5=20；合计 40
  assert.equal(cross.magnitude, 40);
  assert.equal(report.totalMagnitude, 40);
});

test('底数缺失即禁拼，且相邻柜读数不得用于填齐', () => {
  const pipeline = new IngestPipeline('储能电站C', { clock: clockAt() });
  pipeline.ingestRecord('wire', 'w-a', { cabinet: 'Old', channel: '02', point: '关口表', range: ['00:00', '09:00'], scale: 2, direction: 1, revision: 1 });
  pipeline.ingestRecord('wire', 'w-b', { cabinet: 'New', channel: '02', point: '关口表', range: ['09:00', '24:00'], scale: 5, direction: 1, revision: 1 });
  pipeline.ingestRecord('cutover', 'c-2', {
    id: 'CO2', point: '关口表', time: '09:00', continuous: true, base: [100, null],
  });
  pipeline.ingestRecord('sample', 's-2', {
    cabinet: 'Old', channel: '02', sample: 'A2', measured: '08:00',
    exported: '08:10', unit: 'pulse', cumulative: 90, quality: 'good',
  });
  pipeline.ingestRecord('point', 'p-2', {
    cabinet: 'New', channel: '02', seq: 1, sample: 'B2', measured: '09:30',
    unit: 'pulse', cumulative: 24, quality: 'good',
  });
  const report = pipeline.energy('关口表', ['08:00', '10:00']);
  assert.equal(report.splice.allowed, false);
  assert.equal(report.splice.reason, 'missing-handover-base');
  assert.equal(report.blockedBoundaries.length, 1);
  assert.equal(report.increments.filter((item) => item.kind === 'cross-cutover').length, 0);
});

test('段内累计倒退的增量作废，不产生负发电量', () => {
  const pipeline = new IngestPipeline('储能电站D', { clock: clockAt() });
  pipeline.ingestRecord('wire', 'w-1', { cabinet: 'Old', channel: '03', point: '直流侧', range: ['00:00', '24:00'], scale: 1, direction: 1, revision: 1 });
  pipeline.ingestRecord('point', 'q-1', { cabinet: 'Old', channel: '03', seq: 1, sample: 'D1', measured: '10:00', unit: 'pulse', cumulative: 50, quality: 'good' });
  pipeline.ingestRecord('point', 'q-2', { cabinet: 'Old', channel: '03', seq: 2, sample: 'D2', measured: '10:15', unit: 'pulse', cumulative: 47, quality: 'good' });
  const report = pipeline.energy('直流侧', ['09:00', '11:00']);
  assert.equal(report.increments.length, 0);
  assert.deepEqual(report.invalidIncrements.map((item) => item.reason), ['raw-cumulative-regressed']);
});

test('来源客户端按 record 键幂等，重复领取不产生新入站记录', async () => {
  const { server, url } = await start();
  try {
    const client = new SourceClient(url);
    const first = await client.fetchNew('archive');
    const second = await client.fetchNew('archive');
    assert.ok(first.length > 0);
    assert.deepEqual(second, []);
    assert.equal(client.hasSeen('archive', first[0].record), true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('接线补登记可释放早期挂起样本，并按发生时刻适用依据归属', () => {
  const pipeline = new IngestPipeline('储能电站E', { clock: clockAt() });
  pipeline.ingestRecord('point', 'z-1', { cabinet: 'New', channel: '05', seq: 3, sample: 'E1', measured: '11:00', unit: 'pulse', cumulative: 8, quality: 'good' });
  assert.equal(pipeline.store.findObservation('z-1').status, 'suspended');
  pipeline.ingestRecord('wire', 'w-5', { cabinet: 'New', channel: '05', point: '逆变出口', range: ['09:00', '24:00'], scale: 6, direction: -1, revision: 1 });
  const obs = pipeline.store.findObservation('z-1');
  assert.equal(obs.status, 'released');
  const trace = pipeline.store.activeTrace('E1');
  assert.equal(trace.reading, 48);
  assert.equal(trace.basis.direction, -1);
  assert.ok(pipeline.store.events.some((event) => event.type === 'unblocked' && event.sample === 'E1'));
});

test('接线区间左闭右开：边界时刻归后一段', () => {
  const pipeline = new IngestPipeline('储能电站F', { clock: clockAt() });
  pipeline.ingestRecord('wire', 'w-6a', { cabinet: 'New', channel: '06', point: '逆变出口', range: ['00:00', '09:00'], scale: 2, direction: 1, revision: 1 });
  pipeline.ingestRecord('wire', 'w-6b', { cabinet: 'New', channel: '06', point: '逆变出口', range: ['09:00', '24:00'], scale: 3, direction: 1, revision: 1 });
  assert.equal(pipeline.wiring.resolve('New', '06', '08:59').scale, 2);
  assert.equal(pipeline.wiring.resolve('New', '06', '09:00').scale, 3);
  assert.ok(pipeline.wiring.resolve('New', '06', '07:00'));
  // 无任何接线覆盖的通道仍解析为 null，调用方必须挂起
  assert.equal(pipeline.wiring.resolve('New', '99', '09:00'), null);
});
