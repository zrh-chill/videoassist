import { setTimeout as delay } from 'node:timers/promises';
import type { StageHandler } from '../../domain/src/index.js';
import { DomainError } from '../../domain/src/index.js';

export function simulationHandler(durationMs: number): StageHandler {
  return {
    async execute(input, signal) {
      await delay(durationMs, undefined, { signal });
      if (input.options.failStage === input.stage && input.attempt === 1) {
        throw new DomainError('SIMULATED_FAILURE', '模拟阶段故障，可从当前阶段重试', input.options.retryableFailure);
      }
      return { simulated: true, text: '模拟阶段 ' + input.stage + ' 已完成（未处理真实媒体或调用模型）' };
    },
  };
}
