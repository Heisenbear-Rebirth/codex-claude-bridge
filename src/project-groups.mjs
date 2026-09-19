import { randomUUID } from 'node:crypto';
import { parseAddress } from './address.mjs';

export function groupAddress(value) {
  const s = typeof value === 'string' ? parseAddress(value) : parseAddress(`${value.client}:${value.id}`);
  return `${s.client}:${s.client === 'opencode' ? s.id : s.id.toLowerCase()}`;
}
const key = 'custom-projects-v1';
const conflict = () => Object.assign(new Error('该分组已在其他窗口更新，请重新打开后编辑。'), { statusCode: 409 });

export class ProjectGroups {
  constructor(store) { this.store = store; }
  list() { return this.store.getSetting(key) || []; }
  save(input, discovered = []) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80 || /[\u0000-\u001f]/.test(input.name)) throw new Error('组名须为 1—80 个字符。');
    if (!Array.isArray(input.members) || input.members.length > 200 || input.members.some(a => typeof a !== 'string')) throw new Error('请选择最多 200 个会话。');
    const addresses = [...new Set(input.members.map(groupAddress))];
    return this.store.transaction(() => {
      const groups = this.list(), old = input.id ? groups.find(g => g.id === input.id) : null;
      if (input.id && !old) throw conflict();
      if (input.expectedRevision !== (old?.revision || 0)) throw conflict();
      if (!old && groups.length >= 100) throw new Error('最多可创建 100 个自定义项目。');
      const available = new Map(discovered.map(s => [groupAddress(s), s]));
      const saved = new Map((old?.members || []).map(s => [groupAddress(s), s]));
      const members = addresses.map(address => {
        const session = available.get(address) || saved.get(address);
        if (!session) throw new Error('部分会话已不在目录列表中，请刷新后重新选择。');
        const parsed = parseAddress(address);
        return { ...parsed, name: String(session.name || '未命名会话').slice(0, 200), cwd: String(session.cwd || ''), address };
      });
      const stamp = new Date().toISOString();
      const group = { id: old?.id || randomUUID(), name: input.name.trim(), members, revision: (old?.revision || 0) + 1, createdAt: old?.createdAt || stamp, updatedAt: stamp };
      this.store.setSetting(key, old ? groups.map(g => g.id === old.id ? group : g) : [...groups, group]);
      this.store.event('project_group_saved', { id: group.id, revision: group.revision });
      return group;
    });
  }
  remove({ id, expectedRevision }) {
    return this.store.transaction(() => {
      const groups = this.list(), old = groups.find(g => g.id === id);
      if (!old || old.revision !== expectedRevision) throw conflict();
      this.store.setSetting(key, groups.filter(g => g.id !== id));
      this.store.event('project_group_removed', { id });
    });
  }
}
