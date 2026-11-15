import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute = promisify(execFile);

const number = value => value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const clampPercent = value => number(value) === null ? null : Math.max(0, Math.min(100, number(value)));

/** NVIDIA's unsupported counters are not zero. Keep their absence explicit,
 * including machines without a driver or devices unavailable to this process. */
export function parseGpuCounters(csv) {
  return String(csv ?? '').trim().split(/\r?\n/).filter(Boolean).map((line, index) => {
    const fields = line.split(',').map(value => value.trim());
    const [load, used, total] = fields.splice(-3);
    return {id: String(index), name: fields.join(', '), load: clampPercent(load),
      used: number(used) === null ? null : number(used) * 1024 ** 2,
      total: number(total) === null ? null : number(total) * 1024 ** 2};
  });
}

/** Collect on demand with one in-flight sample and a short bounded cache for
 * multiple desktop/phone viewers. There is no background timer or disk history.
 * Dependencies are injectable so unit tests never launch the real driver. */
export function systemStatus({clock = Date.now, system = os, run = execute} = {}) {
  let previous = null, cache = null, pending = null, sampledAt = 0;
  return async () => {
    if (cache && clock() - sampledAt < 3000) return cache;
    if (pending) return pending;
    pending = (async () => {
      const counts = system.cpus().reduce((sum, cpu) => ({idle: sum.idle + cpu.times.idle,
        total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0)}), {idle: 0, total: 0});
      const cpu = previous && counts.total > previous.total
        ? clampPercent(Math.round(100 * (1 - (counts.idle - previous.idle) / (counts.total - previous.total)))) : null;
      previous = counts;
      let devices = [];
      try {
        const gpu = await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
          {windowsHide: true, timeout: 2500, maxBuffer: 16000});
        devices = parseGpuCounters(gpu.stdout);
      } catch { /* Missing driver or unavailable counters must not hide CPU/RAM. */ }
      cache = {host: system.hostname(), cpu, ram: {used: system.totalmem() - system.freemem(), total: system.totalmem()},
        devices, at: clock()};
      sampledAt = clock();
      return cache;
    })().finally(() => {pending = null;});
    return pending;
  };
}
