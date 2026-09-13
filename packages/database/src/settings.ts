import { readFile } from 'node:fs/promises';
import type { Database } from './client.js';
import type { Prisma } from '@prisma/client';
import { resolveSecret, type AppConfig } from '../../config/src/index.js';
import { configValues, withSettings } from '../../config/src/settings.js';
import { settingsSchema, type SettingsValues, type SettingsDto, type TestKind, type ConnectionResult } from '../../contracts/src/settings.js';
import { DomainError, fingerprint } from '../../domain/src/index.js';

async function ensure(tx: Prisma.TransactionClient) {
  return tx.systemSettings.upsert({ where: { id: 'singleton' }, create: {}, update: { id: 'singleton' } });
}
async function promptVersion(tx: Prisma.TransactionClient, name: string, body: string) {
  const hash = fingerprint(body);
  const old = await tx.promptVersion.findUnique({ where: { hash } });
  if (old) return old;
  const revision = ((await tx.promptVersion.aggregate({ _max: { revision: true } }))._max.revision ?? 0) + 1;
  return tx.promptVersion.create({ data: { name, body, hash, revision } });
}
export class Settings {
  constructor(public db: Database, public base: AppConfig) {}
  async effective() {
    const row = await this.db.systemSettings.findUnique({ where: { id: 'singleton' } });
    return withSettings(this.base, settingsSchema.parse(JSON.parse(row?.valuesJson || '{}')));
  }
  async view(): Promise<SettingsDto> {
    const row = await this.db.systemSettings.findUnique({ where: { id: 'singleton' } });
    const saved = settingsSchema.parse(JSON.parse(row?.valuesJson || '{}'));
    const c = withSettings(this.base, saved); const values = configValues(c);
    const tests = JSON.parse(row?.testsJson || '{}') as SettingsDto['tests'];
    for (const result of Object.values(tests)) if (result) result.stale = result.configHash !== fingerprint(values);
    return { revision: row?.revision || 0, storage: { dataDir: c.dataDir, host: c.host, port: c.port }, tests,
      fields: await Promise.all((Object.keys(values) as Array<keyof SettingsValues>).map(async key => {
        const secret = key.endsWith('_REF'); const value = values[key];
        let configured: boolean | undefined;
        if (secret) { try { if (key === 'BILIBILI_COOKIE_FILE_REF') { if (!value) throw Error(); await readFile(String(value).slice(5)); } else resolveSecret(String(value)); configured = true; } catch { configured = false; } }
        // Never echo secret references (including local secret-file paths) or resolved values.
        let visible = value;
        if (key.endsWith('_BASE_URL')) {
          try { const url = new URL(String(value)); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; visible = url.toString(); }
          catch { visible = ''; }
        }
        return { key, value: secret ? null : visible,
          source: this.base.lockedSettings.includes(key) ? 'environment' as const : key in saved ? 'database' as const : 'default' as const,
          secret, configured, referenceType: secret ? String(value).split(':')[0] || '未配置' : undefined };
      })),
    };
  }
  async save(values: SettingsValues, revision: number) {
    const patch = settingsSchema.parse(values);
    return this.db.$transaction(async tx => {
      const row = await ensure(tx);
      if (row.revision !== revision) throw new DomainError('SETTINGS_CONFLICT', '设置已被修改，请重新加载后保存', false, 409);
      const locked = Object.keys(patch).filter(key => this.base.lockedSettings.includes(key));
      if (locked.length) throw new DomainError('SETTINGS_LOCKED', '环境变量已覆盖这些设置，请在服务端修改：' + locked.join('、'), false, 409);
      await tx.systemSettings.update({ where: { id: row.id }, data: { valuesJson: JSON.stringify({ ...JSON.parse(row.valuesJson), ...patch }), revision: { increment: 1 } } });
      return { revision: revision + 1 };
    });
  }
  async activePrompt() {
    const row = await this.db.systemSettings.findUnique({ where: { id: 'singleton' } });
    if (row?.activePromptId) return this.db.promptVersion.findUniqueOrThrow({ where: { id: row.activePromptId } });
    const document = await readFile(this.base.summaryPromptFile, 'utf8');
    const body = /\x60\x60\x60text\r?\n([\s\S]*?)\r?\n\x60\x60\x60/.exec(document)?.[1] || document;
    return this.db.$transaction(async tx => {
      const current = await ensure(tx);
      if (current.activePromptId) return tx.promptVersion.findUniqueOrThrow({ where: { id: current.activePromptId } });
      return promptVersion(tx, '视频总结', body);
    });
  }
  async prompts() {
    const active = await this.activePrompt();
    return (await this.db.promptVersion.findMany({ orderBy: { revision: 'desc' } })).map(p => ({ ...p, active: p.id === active.id }));
  }
  async createPrompt(input: { name: string; body: string }, key: string) {
    return this.db.$transaction(async tx => {
      await ensure(tx);
      const hash = fingerprint({ action: 'prompt', ...input });
      await tx.command.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      const prior = await tx.command.findUnique({ where: { key } });
      if (prior) {
        if (prior.fingerprint !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT', '请求键已用于其他内容', false, 409);
        return JSON.parse(prior.responseJson) as { id: string; revision: number };
      }
      const version = await promptVersion(tx, input.name, input.body);
      await tx.systemSettings.update({ where: { id: 'singleton' }, data: { activePromptId: version.id } });
      const result = { id: version.id, revision: version.revision };
      await tx.command.create({ data: { key, fingerprint: hash, responseJson: JSON.stringify(result), expiresAt: new Date(Date.now() + 86400000) } });
      return result;
    });
  }
  async recordTest(kind: TestKind, result: ConnectionResult) {
    await this.db.$transaction(async tx => {
      const row = await ensure(tx);
      await tx.systemSettings.update({ where: { id: row.id }, data: { testsJson: JSON.stringify({ ...JSON.parse(row.testsJson), [kind]: result }) } });
    });
  }
}
