// 现场时刻统一用“当日分钟数”表示：00:00 -> 0，24:00 -> 1440。
// 接线区间一律左闭右开 [start, end)。

export function parseHM(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match) throw new Error(`无法解析时刻: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const total = hour * 60 + minute;
  if (hour > 24 || minute > 59 || total > 1440) {
    throw new Error(`时刻越界: ${value}`);
  }
  return total;
}

export function formatHM(total) {
  if (total === 1440) return '24:00';
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function toInterval(range) {
  return [parseHM(range[0]), parseHM(range[1])];
}

// 左闭右开判定
export function contains(interval, t) {
  return interval[0] <= t && t < interval[1];
}

export function overlaps(a, b) {
  return a[0] < b[1] && b[0] < a[1];
}

export function intersection(a, b) {
  const start = Math.max(a[0], b[0]);
  const end = Math.min(a[1], b[1]);
  return start < end ? [start, end] : null;
}
