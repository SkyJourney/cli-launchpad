import type { en } from "./locales/en";

type LeafPaths<T, Prefix extends string = ""> = {
  [Key in keyof T & string]: T[Key] extends string
    ? `${Prefix}${Key}`
    : LeafPaths<T[Key], `${Prefix}${Key}.`>;
}[keyof T & string];

/** en locale 里全部叶子键的点分路径；新增扩展点的文案键用它做类型约束。 */
export type LocaleKey = LeafPaths<typeof en>;
