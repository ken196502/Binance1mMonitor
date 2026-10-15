import path from 'node:path';
import { loadDataset } from './data.ts';
import { buildFrames } from './backtest.ts';
import { fetchGainersMinutes, loadGainersMinutes } from './gainers-data.ts';
import { ARCHIVE_BASE } from './gainers-archive.ts';
import { DAY, HOUR } from './types.ts';
import { fetchMonitorDaily, loadMonitorDaily, monitorFrames, planMonitorDaily, planMonitorMinutes } from './monitor-data.ts';

export async function prepareMonitorData(options: { dataDir: string; cacheDir: string; start?: number; end?: number; days: number; horizon: number; fetch: boolean }, log = console.log) {
  const hourly = await loadDataset(options.dataDir);
  const end = options.end ?? Math.floor(hourly.manifest.end / DAY) * DAY;
  const start = options.start ?? end - options.days * DAY;
  if (![start, end].every((t) => Number.isFinite(t) && t % HOUR === 0) || start >= end || start < hourly.manifest.start || end > hourly.manifest.end) throw new Error('研究区间须在小时缓存内且按小时对齐');
  hourly.manifest = { ...hourly.manifest, start, end };
  const frames = monitorFrames(buildFrames(hourly, 12, 1));
  const plan = planMonitorMinutes(hourly, frames, options.horizon);
  const dailyPlan = planMonitorDaily(hourly, Object.keys(plan.ranges));
  const minuteDir = path.join(options.cacheDir, '1m'), dailyDir = path.join(options.cacheDir, '1d');
  log(`新维度数据：${new Date(start).toISOString()} → ${new Date(end).toISOString()}，${Object.keys(plan.ranges).length}币种，涨跌榜独立`);
  if (options.fetch) {
    await fetchGainersMinutes(minuteDir, plan, ARCHIVE_BASE, log);
    await fetchMonitorDaily(dailyDir, dailyPlan, log, hourly);
  }
  const minute = await loadGainersMinutes(minuteDir, plan);
  const daily = await loadMonitorDaily(dailyDir, dailyPlan);
  return { hourly, frames, minute, daily, start, end };
}
