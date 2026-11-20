// 端到端演练：在进程内启动合成来源，按 4 个回放阶段推进入站流水线，
// 打印重放去重、接线修订失效、累计量禁拼、保存期/挂起区分与补票结果。
// 运行：node demo.mjs

import { start } from './source-server.mjs';
import { ConsumerView } from './lib/consumer.mjs';
import { IngestPipeline } from './lib/pipeline.mjs';

function fakeClock() {
  let minute = 9 * 60; // 09:00 起，每收一条推进一分钟，保证演练可复算
  return () => {
    const value = new Date(`2026-11-20T${format(minute)}.000Z`);
    minute += 1;
    return value;
  };
}

function format(total) {
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

const { server, url } = await start();
try {
  const pipeline = new IngestPipeline('储能电站A', { clock: fakeClock() });
  pipeline.connect(url);
  const consumer = new ConsumerView(pipeline);
  const invalidations = [];
  consumer.on('invalidation', (event) => invalidations.push(event));

  const banner = (text) => console.log(`\n=== ${text} ===`);

  for (let stage = 1; stage <= 4; stage += 1) {
    const summary = await pipeline.advanceStage(stage);
    consumer.sync();
    banner(`阶段 ${stage}（新入站信封 ${summary.ingested} 条）`);
    for (const event of pipeline.store.events.filter((item) => !item._shown)) {
      event._shown = true;
      console.log(JSON.stringify(event));
    }
  }

  banner('物理测点当前有效序列（旧柜重放未产生第二份读数）');
  for (const point of ['逆变出口', '并网侧']) {
    console.log(point, JSON.stringify(pipeline.series(point), null, 0));
  }

  banner('逆变出口：跨换接点电量（应被阻断，禁止差值当发电量）');
  console.log(JSON.stringify(pipeline.energy('逆变出口', ['08:45', '09:30']), null, 2));

  banner('New|04 覆盖台账：pending / unrecoverable / suspended 明确区分');
  console.log(JSON.stringify(consumer.confirmedCoverage('New', '04'), null, 2));

  banner('New|08：无接线依据持续挂起，不拖累 04 通道');
  console.log(JSON.stringify(consumer.confirmedCoverage('New', '08'), null, 2));

  banner('Old|04：保存期底数 08:45，更早区段不可恢复而非完整');
  console.log(JSON.stringify(consumer.confirmedCoverage('Old', '04'), null, 2));

  banner('检修补票：只取缺失时段，不重取全站');
  for (const [cabinet, channel] of [['Old', '04'], ['New', '04'], ['New', '08']]) {
    console.log(JSON.stringify(consumer.backfillTicket(cabinet, channel)));
  }

  banner('失效通知：指到具体接线事件、区间与样本');
  console.log(JSON.stringify(invalidations, null, 2));

  banner('连续段（修订后逆变出口连续性暂时倒退）');
  console.log(JSON.stringify(pipeline.pointRuns('逆变出口'), null, 2));
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
