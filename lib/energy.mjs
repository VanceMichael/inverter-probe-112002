// 累计量解释与电量窗口计算。
//
// 铁律（对应施工交接规则）：
// 1. 原始累计值是脉冲数，必须按“发生时刻适用接线”的 scale 解释，方向用 direction 记符号；
// 2. 同一段连续计量内，相邻样本差值才能当发电量；原始累计倒退则该增量作废并标记；
// 3. 跨换接点只有 evaluateCutover 放行（表计连续且双方底数齐全）才允许拼接，
//    否则边界两侧各自成段，边界增量标记 blocked，禁止拿差值凑发电量；
// 4. 任何缺测/挂起区段都不做线性补齐，更不能用相邻柜的读数填。

import { parseHM } from './time.mjs';

function signedMagnitude(trace) {
  return trace.rawCumulative * trace.basis.scale;
}

export function energyWindow(store, wiring, point, window) {
  const [winStart, winEnd] = [parseHM(window[0]), parseHM(window[1])];
  const cutovers = wiring.cutoversOf(point);
  const decision = wiring.evaluateCutover(point);

  const result = {
    point,
    window: [winStart, winEnd],
    splice: { allowed: decision.allowed, reason: decision.reason, cutoverId: decision.cutover?.id ?? null },
    increments: [],
    blockedBoundaries: [],
    invalidIncrements: [],
    totalMagnitude: 0,
    totalSigned: 0,
  };

  const inWindow = (minute) => minute >= winStart && minute < winEnd;

  // 窗口内该测点所有有效释出，按发生时刻排列并按换接事件/通道变化切段。
  const traces = store.activeReleases(point)
    .map((release) => store.activeTrace(release.sample))
    .filter((trace) => trace && inWindow(trace.measuredMin))
    .sort((a, b) => a.measuredMin - b.measuredMin);

  const groups = [];
  let current = [];
  for (const trace of traces) {
    if (current.length === 0) {
      current.push(trace);
      continue;
    }
    const prev = current.at(-1);
    const channelChanged = prev.inbound.cabinet !== trace.inbound.cabinet
      || prev.inbound.channel !== trace.inbound.channel;
    const cutoverBetween = cutovers.some((item) => prev.measuredMin < item.time && item.time <= trace.measuredMin);
    if (channelChanged || cutoverBetween) {
      groups.push(current);
      current = [trace];
    } else {
      current.push(trace);
    }
  }
  if (current.length) groups.push(current);

  // 段内增量
  for (const group of groups) {
    for (let i = 0; i < group.length - 1; i += 1) {
      pushIncrement(result, group[i], group[i + 1]);
    }
  }

  // 换接边界：逐事件判定，即使对侧没有有效样本（被修订改属、挂起或未到达）也显式阻断。
  for (const cutover of cutovers) {
    if (cutover.time < winStart || cutover.time > winEnd) continue;
    const before = [...traces].reverse().find((trace) => trace.measuredMin < cutover.time) ?? null;
    const after = traces.find((trace) => trace.measuredMin >= cutover.time) ?? null;
    if (!before && !after) continue;

    if (decision.allowed && before && after && decision.cutover?.id === cutover.id) {
      const offset = cutover.baseOld * before.basis.scale - cutover.baseNew * after.basis.scale;
      const oldPart = cutover.baseOld * before.basis.scale - signedMagnitude(before);
      const newPart = signedMagnitude(after) - cutover.baseNew * after.basis.scale;
      const magnitude = oldPart + newPart;
      result.increments.push({
        kind: 'cross-cutover',
        cutoverId: cutover.id,
        from: before ? before.inbound.sample : null,
        to: after ? after.inbound.sample : null,
        boundary: cutover.time,
        magnitude,
        signed: magnitude * (before?.basis.direction ?? after.basis.direction),
        offset,
      });
    } else {
      result.blockedBoundaries.push({
        cutoverId: cutover.id,
        reason: decision.reason ?? 'unknown',
        from: before ? before.inbound.sample : null,
        to: after ? after.inbound.sample : null,
        boundary: cutover.time,
        note: '换接段计量范围无法证明，差值不得作为发电量，也不得用相邻柜填齐',
      });
    }
  }

  result.totalMagnitude = result.increments.reduce((sum, item) => sum + item.magnitude, 0);
  result.totalSigned = result.increments.reduce((sum, item) => sum + item.signed, 0);
  return result;
}

function pushIncrement(result, a, b) {
  const rawDiff = b.rawCumulative - a.rawCumulative;
  if (rawDiff < 0) {
    result.invalidIncrements.push({
      from: sampleName(a),
      to: sampleName(b),
      rawDiff,
      reason: 'raw-cumulative-regressed',
    });
    return;
  }
  // 段内要求接线倍率一致；倍率变化说明依据已修订，应由修订流程另立痕迹，不在这里混算。
  if (a.basis.scale !== b.basis.scale) {
    result.invalidIncrements.push({
      from: sampleName(a),
      to: sampleName(b),
      reason: 'basis-scale-changed',
    });
    return;
  }
  const magnitude = rawDiff * a.basis.scale;
  result.increments.push({
    kind: 'within-run',
    from: sampleName(a),
    to: sampleName(b),
    rawDiff,
    magnitude,
    signed: magnitude * a.basis.direction,
  });
}

function sampleName(trace) {
  // trace 不直接存样本名，经 recordKey 反查不到时回退为入站 sample。
  return trace.inbound.sample;
}
