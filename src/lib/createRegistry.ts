export interface RegistryItem {
  id: string;
  apiVersion: number;
}

export interface RegistryMessages {
  emptyId: string;
  unsupportedApiVersion: (apiVersion: number) => string;
  duplicateId: (id: string) => string;
  /** 只在配置了 keyOf 时使用；缺省时用 duplicateId。 */
  duplicateKey?: (key: string) => string;
}

export interface RegistryOptions<T extends RegistryItem> {
  /** 用于日志与失败清单，例如 "workspaceContentAdapter"。 */
  name: string;
  supportedApiVersions: readonly number[];
  messages: RegistryMessages;
  /** 次级唯一键（例如内容 adapter 的 kind）；缺省时次级键等于 id。 */
  keyOf?: (item: T) => string;
  /** 抛出 Error 表示拒绝该项；在其余检查之后最后执行。 */
  validate?: (item: T) => void;
}

export interface Registry<T extends RegistryItem> {
  readonly name: string;
  /** 被拒绝时抛出带 messages 文案的 Error；返回的注销函数只在该实例仍是已注册项时生效。 */
  register(item: T): () => void;
  get(id: string): T | undefined;
  getByKey(key: string): T | undefined;
  /** 按注册顺序返回快照数组，之后的注册不会改变已返回的数组。 */
  list(): readonly T[];
  subscribe(listener: () => void): () => void;
  /** 每次成功注册与每次有效注销各加 1。 */
  revision(): number;
}

export function createRegistry<T extends RegistryItem>(
  options: RegistryOptions<T>,
): Registry<T> {
  const { name, supportedApiVersions, messages, keyOf, validate } = options;
  const itemsById = new Map<string, T>();
  const itemsByKey = new Map<string, T>();
  const listeners = new Set<() => void>();
  let revision = 0;

  const keyFor = (item: T) => (keyOf ? keyOf(item) : item.id);
  const notifyChanged = () => {
    revision += 1;
    listeners.forEach((listener) => listener());
  };

  return {
    name,
    register(item) {
      if (!item.id.trim()) throw new Error(messages.emptyId);
      if (!supportedApiVersions.includes(item.apiVersion)) {
        throw new Error(messages.unsupportedApiVersion(item.apiVersion));
      }
      if (itemsById.has(item.id)) {
        throw new Error(messages.duplicateId(item.id));
      }
      const key = keyFor(item);
      if (keyOf && itemsByKey.has(key)) {
        throw new Error((messages.duplicateKey ?? messages.duplicateId)(key));
      }
      validate?.(item);

      itemsById.set(item.id, item);
      itemsByKey.set(key, item);
      notifyChanged();
      return () => {
        if (itemsById.get(item.id) !== item) return;
        itemsById.delete(item.id);
        itemsByKey.delete(key);
        notifyChanged();
      };
    },
    get: (id) => itemsById.get(id),
    getByKey: (key) => itemsByKey.get(key),
    list: () => [...itemsById.values()],
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    revision: () => revision,
  };
}
