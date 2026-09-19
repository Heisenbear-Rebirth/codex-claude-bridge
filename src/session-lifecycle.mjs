import { randomUUID, createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseAddress, publicSession } from './address.mjs';
import { sameDirectory } from './opencode-bridge.mjs';
import { readAccessPolicy } from './access-policy.mjs';
import { lifecycleEnabled } from './lifecycle-availability.mjs';

export const lifecycleFields = ['requestId', 'client', 'directory', 'title', 'to', 'prompt'];
export class SessionLifecycle {
  constructor({ store, adapters, root, directories = [root], runtimeFactory, accessPolicy }) {
    this.accessPolicy = accessPolicy;
    this.root = root;
    this.store = store; this.adapters = adapters; this.directories = directories; this.runtimeFactory = runtimeFactory; this.inFlight = new Map();
  }
  capabilities() {
    if (!lifecycleEnabled(this.root)) return null;
    return Object.fromEntries(['codex','claude','opencode'].map(client => [client, {
      create: typeof this.adapters[client]?.createSession === 'function',
      connect: Boolean(this.adapters[client]), wakeHost: false, openNativeUi: false,
      detail: client === 'opencode' ? '使用已运行的原生后端创建或连接；原生窗口显示需单独打开。'
        : client === 'codex' ? '可核对已加载会话。当前 App Tools 创建接口未核实，未加载会话仍需原 App 打开。'
          : '在 Cooperation 专用原生面板中创建或恢复，保留原生权限交互；新建需提供首条提示。',
    }]));
  }
  async execute(action, args, origin) {
    const admission = { reserved: false };
    try { return await this.executeValidated(action, args, origin, admission); }
    catch (error) { if (!admission.reserved) error.notSubmitted = true; throw error; }
  }
  async executeValidated(action, args, origin, admission) {
    if (this.closed) throw new Error('生命周期服务正在关闭。');
    if (!['create', 'connect'].includes(action) || !args || Object.keys(args).some(k => !lifecycleFields.includes(k))) throw new Error('不支持的会话操作字段。');
    const access = this.accessPolicy || await readAccessPolicy();
    access.assert(args.directory);
    if (!lifecycleEnabled(this.root)) throw Object.assign(new Error('主动创建和加载会话方向已取消，实验入口已停用。'), { code: 'LIFECYCLE_DISABLED' });
    if (typeof args.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(args.requestId)) throw new Error('请提供稳定的 requestId；未知结果必须使用原 requestId 核对。');
    if (typeof args.directory !== 'string' || !this.directories.some(d => sameDirectory(d, args.directory))) throw new Error('生命周期操作仅允许明确授权的精确目录。');
    const cwd = await realpath(resolve(args.directory));
    access.assert(cwd);
    if (!this.directories.some(d => sameDirectory(d, cwd)) || !(await stat(cwd)).isDirectory()) throw new Error('目录实际位置不在生命周期授权范围内。');
    let target, client;
    if (action === 'create') {
      client = args.client;
      if (!['codex','claude','opencode'].includes(client) || args.to !== undefined || args.title !== undefined && (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 120)) throw new Error('新建会话参数不正确。');
      if (args.prompt !== undefined && (typeof args.prompt !== 'string' || !args.prompt.trim() || Buffer.byteLength(args.prompt) > 256 * 1024)) throw new Error('首条提示格式不正确或过长。');
      if (args.prompt !== undefined && client === 'opencode') throw new Error('OpenCode 创建后请通过 send_message 发送初始任务。');
      if (this.adapters[client]?.createSession && client !== 'opencode' && !args.prompt) throw new Error('此原生客户端创建会话需要首条提示。');
    } else {
      target = parseAddress(args.to); client = target.client;
      if (client !== 'opencode') target.id = target.id.toLowerCase();
      if (args.client !== undefined || args.title !== undefined || args.prompt !== undefined) throw new Error('连接会话只接受 to、directory 与 requestId。');
    }
    let sender = null;
    if (origin?.from) {
      const address = parseAddress(`${origin.from.client}:${origin.from.id}`);
      sender = await this.adapters[address.client]?.find(address.id, { directory: cwd });
      if (!sender || sender.client !== address.client || (address.client === 'opencode' ? sender.id !== address.id : sender.id?.toLowerCase() !== address.id.toLowerCase())
        || !sameDirectory(sender.cwd, cwd)) throw new Error('来源会话未核实或不在目标授权目录中。');
      if (this.store.activeCycle(sender)) throw new Error('来源会话正在维护，暂不能执行生命周期操作。');
    } else if (origin?.kind !== 'management-ui') throw new Error('缺少真实来源身份。');
    const source = sender ? { ...publicSession(sender), kind: origin.kind, nativeMessageId: origin.nativeMessageId || null, instanceId: origin.instanceId || null } : { kind: 'management-ui' };
    const input = { action, client, cwd, title: args.title?.trim() || null, to: target ? `${target.client}:${target.id}` : null, ...(args.prompt ? { prompt: args.prompt } : {}) };
    const scope = sender ? `${sender.client}:${sender.id}` : 'management-ui';
    const key = createHash('sha256').update(scope + ':' + args.requestId).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if (this.closed) throw new Error('生命周期服务正在关闭。');
    const saved = this.store.reserveLifecycle({ key, fingerprint, requestId: args.requestId, operationId: randomUUID(), input, source });
    admission.reserved = true;
    if (saved.fingerprint !== fingerprint) throw new Error('requestId 已用于不同的操作参数。');
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    if (!saved.fresh) return this.reconcile(saved);
    const work = this.run(saved).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work); return work;
  }
  async reconcile(record) {
    if (record.state === 'unknown' && record.input.action === 'create') {
      try {
        const result = await this.adapters[record.input.client]?.reconcileCreate?.({ ...record.input, operationId: record.operationId });
        if (result?.session) return this.finish(record, result);
      } catch { /* Read-only reconciliation never repeats creation. */ }
    }
    return this.public(record);
  }
  async run(record) {
    const { input } = record, adapter = this.adapters[input.client];
    if (input.action === 'create' && !adapter?.createSession) return this.finish(record, { status: 'unsupported', detail: this.capabilities()[input.client].detail });
    try {
      if (input.action === 'create') return this.finish(record, await adapter.createSession({ ...input, operationId: record.operationId, source: record.source }));
      const target = parseAddress(input.to), session = await adapter?.find(target.id, { directory: input.cwd });
      if (!session || !sameDirectory(session.cwd, input.cwd)) return this.finish(record, { status: 'unavailable', detail: '目标不在所选目录的可达原生后端中。' });
      if (this.store.activeCycle(session)) return this.finish(record, { status: 'blocked', detail: '目标正在维护，暂不能改变连接。' });
      if (adapter.connectSession) return this.finish(record, await adapter.connectSession({ targetId: target.id, cwd: input.cwd }));
      const runtime = this.runtimeFactory(session);
      try {
        const state = await runtime.status();
        return this.finish(record, { status: state.connected ? 'connected' : 'unavailable', session: publicSession(session),
          nativeRecorded: true, hostReachable: state.connected === true, loaded: state.connected === true,
          sendReady: state.capabilities?.sendMessage === undefined ? null : state.connected === true && state.capabilities.sendMessage === true,
          displayConfirmed: false, modelProcessed: false, detail: this.capabilities()[input.client].detail });
      } finally { runtime.close(); }
    } catch (error) {
      return this.finish(record, { status: input.action === 'create' && error.outcome !== 'not_submitted' ? 'unknown' : 'unavailable',
        detail: error.outcome === 'not_submitted' ? error.message : input.action === 'create' ? '创建未确认；使用相同 requestId 核对，系统不会重复创建。' : '原生客户端未连接；请在原生界面打开该会话。' });
    }
  }
  finish(record, result) {
    if (result.session && (!sameDirectory(result.session.cwd, record.input.cwd) || result.session.client !== record.input.client
      || record.input.to && `${result.session.client}:${result.session.id}` !== record.input.to)) throw new Error('原生结果身份或目录不匹配。');
    const session = result.session ? publicSession(result.session) : null;
    return this.public(this.store.finishLifecycle(record.key, { ...result, ...(session ? { session, address: session.address } : {}) }));
  }
  public(record) { return { operationId: record.operationId, requestId: record.requestId, ...record.result, status: record.state }; }
  async close() { this.closed = true; await Promise.allSettled(this.inFlight.values()); }
}
