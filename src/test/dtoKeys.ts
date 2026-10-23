/**
 * 编译期要求键清单恰好覆盖类型 T 的全部键：缺键时参数类型变成带 missingKeys 的对象，
 * 数组字面量不满足它，tsc 失败；多写一个不存在的键则不满足 K 的约束，tsc 失败。
 */
export function keysOf<T>() {
  return <const K extends readonly (keyof T & string)[]>(
    keys: K &
      ([Exclude<keyof T & string, K[number]>] extends [never]
        ? unknown
        : { missingKeys: Exclude<keyof T & string, K[number]> }),
  ): readonly string[] => keys;
}
