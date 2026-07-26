/**
 * mvu-sim 测试 — 语义对齐 MagVarUpdate 源码（本地参考 magvarupdate/）与
 * 酒馆助手宏实现。多个用例直接移植自 magvarupdate/tests 的真实断言。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  toPathParts,
  getAtPath,
  hasAtPath,
  setAtPath,
  mergeInitData,
  trimQuotesAndBackslashes,
  parseCommandValue,
  parseParameters,
  pathFix,
  extractCommands,
  applyUpdateBlocks,
  parseSimpleYaml,
  yamlStringify,
  extractSetvarCalls,
  parseInitialVariables,
  substituteVariableMacros,
  omitDollarKeysDeep,
  applyMvuDisplayPostProcess,
  stripStatusCurrentVariable,
  buildVariableTimeline,
  exceedsDepth,
  type StatData,
} from './mvu-sim';

// ============================================================================
// 路径工具
// ============================================================================

describe('toPathParts', () => {
  it('解析点路径与数字下标', () => {
    expect(toPathParts('a.b.c')).toEqual(['a', 'b', 'c']);
    expect(toPathParts('a[0].b')).toEqual(['a', '0', 'b']);
    expect(toPathParts('好感度')).toEqual(['好感度']);
  });

  it('解析引号 bracket 键（含空格与转义）', () => {
    expect(toPathParts('a["x y"].c')).toEqual(['a', 'x y', 'c']);
    expect(toPathParts("a['k']")).toEqual(['a', 'k']);
    expect(toPathParts('a[裸键]')).toEqual(['a', '裸键']);
  });
});

describe('get/has/setAtPath', () => {
  it('get 缺失路径返回 undefined，has 区分存在的 undefined', () => {
    const obj = { a: { b: 1 }, c: [10, 20] };
    expect(getAtPath(obj, 'a.b')).toBe(1);
    expect(getAtPath(obj, 'c.1')).toBe(20);
    expect(getAtPath(obj, 'a.x')).toBeUndefined();
    expect(hasAtPath(obj, 'a.b')).toBe(true);
    expect(hasAtPath(obj, 'a.x')).toBe(false);
    expect(hasAtPath(obj, 'c.0')).toBe(true);
    expect(hasAtPath(obj, 'c.5')).toBe(false);
  });

  it('set 自动创建中间容器：下一段纯数字建数组，否则建对象', () => {
    const obj: StatData = {};
    setAtPath(obj, 'a.b.0', 'x');
    expect(obj).toEqual({ a: { b: ['x'] } });
    setAtPath(obj, 'a.c.k', 1);
    expect((obj.a as Record<string, unknown>).c).toEqual({ k: 1 });
  });
});

describe('mergeInitData（correctlyMerge 语义）', () => {
  it('深合并对象、数组整体替换', () => {
    const target = { a: { x: 1, y: 2 }, list: [1, 2, 3] };
    mergeInitData(target, { a: { y: 9, z: 3 }, list: [4, 5] });
    expect(target).toEqual({ a: { x: 1, y: 9, z: 3 }, list: [4, 5] });
  });
});

// ============================================================================
// 值解析
// ============================================================================

describe('parseCommandValue', () => {
  it('布尔 / null / undefined / 数字 / JSON', () => {
    expect(parseCommandValue('true')).toBe(true);
    expect(parseCommandValue('false')).toBe(false);
    expect(parseCommandValue('null')).toBeNull();
    expect(parseCommandValue('undefined')).toBeUndefined();
    expect(parseCommandValue('42')).toBe(42);
    expect(parseCommandValue('-3.5')).toBe(-3.5);
    expect(parseCommandValue('"quoted"')).toBe('quoted');
    expect(parseCommandValue('{"a": 1}')).toEqual({ a: 1 });
    expect(parseCommandValue('[1, 2]')).toEqual([1, 2]);
  });

  it('宽松 JSON：裸键 / 单引号 / 尾逗号', () => {
    expect(parseCommandValue("{ name: '钥匙', count: 2, }")).toEqual({ name: '钥匙', count: 2 });
    expect(parseCommandValue("['a', 'b']")).toEqual(['a', 'b']);
  });

  it('四则运算（对齐 mathjs 常见输出）', () => {
    expect(parseCommandValue('10 + 2')).toBe(12);
    expect(parseCommandValue('(3 + 5) * 2')).toBe(16);
    expect(parseCommandValue('10 / 4')).toBe(2.5);
    expect(parseCommandValue('7 % 3')).toBe(1);
  });

  it('裸字符串去首尾引号', () => {
    expect(parseCommandValue("'hello world'")).toBe('hello world');
    expect(parseCommandValue('教堂')).toBe('教堂');
    expect(parseCommandValue('10:30')).toBe('10:30');
  });

  it('YAML 兜底级：`key: value` 形态的裸值解析为对象（对齐真实链的 YAML.parse 级）', () => {
    expect(parseCommandValue('状态: 良好')).toEqual({ 状态: '良好' });
  });
});

// ============================================================================
// 命令提取
// ============================================================================

describe('extractCommands — _.xxx() 调用', () => {
  it('基础 set 带 //原因', () => {
    const { commands } = extractCommands("_.set('好感度', 0, 5);//初次见面");
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe('set');
    expect(commands[0].args).toEqual(["'好感度'", '0', '5']);
    expect(commands[0].reason).toBe('初次见面');
  });

  it('嵌套 ); 字符串不提前截断（移植自 extractSetCommands 测试）', () => {
    const { commands } = extractCommands(
      `_.set('path', ["text with _.set('inner',null);//comment"], []);`,
    );
    expect(commands).toHaveLength(1);
    expect(commands[0].args[0]).toBe("'path'");
  });

  it('缺分号的调用被忽略', () => {
    const { commands } = extractCommands("_.set('a', 1)");
    expect(commands).toHaveLength(0);
  });

  it('多条命令按出现顺序返回（分行——同行时 // 注释会吞掉行尾，与真实一致）', () => {
    const { commands } = extractCommands(
      "前文 _.add('金币', 10);//捡到\n中间 _.set('地点', '酒馆', '教堂');//移动",
    );
    expect(commands.map((c) => c.type)).toEqual(['add', 'set']);
    // 真实 MVU 的注释正则 /^\s*\/\/(.*)/ 吃到行尾：同行的第二条命令会被吸进 reason
    const sameLine = extractCommands("_.add('金币', 10);//捡到 _.set('地点', '酒馆');");
    expect(sameLine.commands).toHaveLength(1);
  });

  it('别名 assign/remove/unset 在提取层保留原名', () => {
    const { commands } = extractCommands("_.assign('列表', 'x'); _.remove('列表', 'x'); _.unset('废弃路径');");
    expect(commands.map((c) => c.type)).toEqual(['assign', 'remove', 'unset']);
  });
});

describe('extractCommands — JSONPatch 块', () => {
  it('解析 <JSONPatch> 大小写变体与围栏（移植自 json_patch 测试）', () => {
    const message = `<JSONPatch>
[
  { "op": "replace", "path": "/stat_data/好感度", "value": 10 },
  { "op": "delta", "path": "/stat_data/金币", "value": -5 }
]
</JSONPatch>`;
    const { commands } = extractCommands(message);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({ type: 'set', args: ['stat_data.好感度', '10'], reason: 'json_patch' });
    expect(commands[1]).toMatchObject({ type: 'add', args: ['stat_data.金币', '-5'] });
  });

  it('insert 翻译：数字下标裸传、字符串键加引号、保留 - token', () => {
    const message = `<json_patch>[
      {"op":"insert","path":"/物品/-","value":"钥匙"},
      {"op":"insert","path":"/物品/0","value":"盾"},
      {"op":"insert","path":"/背包/新键","value":1}
    ]</json_patch>`;
    const { commands } = extractCommands(message);
    expect(commands[0].args).toEqual(['物品', "'-'", '"钥匙"']);
    expect(commands[1].args).toEqual(['物品', '0', '"盾"']);
    expect(commands[2].args).toEqual(['背包', "'新键'", '1']);
  });

  it('多个块都被提取（移植自「含有多个标签的场合」）', () => {
    const value = `<JsonPatch>[{"op": "replace", "path": "/1", "value": ["bar", "baz"]}]</JsonPatch>
<JsonPatch>[{"op": "replace", "path": "/2", "value": ["bar", "baz"]}]</JsonPatch>`;
    const { commands } = extractCommands(value);
    expect(commands).toHaveLength(2);
  });

  it('解析失败的块进 warnings 而非静默丢弃', () => {
    const { commands, warnings } = extractCommands('<JSONPatch>这不是 JSON</JSONPatch>');
    expect(commands).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });

  it('op 缺 path：整块作废（对齐真实 isJsonPatch 的 every 校验），不部分执行', () => {
    // 单个坏 op：真实引擎整块忽略——绝不能翻译成根路径 set 把 stat_data 整个换掉
    const missing = extractCommands('<json_patch>[{"op":"replace","value":{"hp":0}}]</json_patch>');
    expect(missing.commands).toHaveLength(0);
    // 合法 + 坏 op 混合：合法的那条同样不执行
    const mixed = extractCommands(
      '<json_patch>[{"op":"replace","path":"/a","value":2},{"op":"replace","value":9}]</json_patch>',
    );
    expect(mixed.commands).toHaveLength(0);
  });

  it('空数组是合法 patch：零命令、不产生「解析失败」警告', () => {
    const { commands, warnings } = extractCommands('<json_patch>[]</json_patch>');
    expect(commands).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('JSON5 风格（裸键/单引号）patch 可执行（对齐真实 parseString 的宽容度）', () => {
    const { commands } = extractCommands(`<json_patch>[{op: 'replace', path: '/hp', value: 0}]</json_patch>`);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: 'set', args: ['hp', '0'] });
  });

  it('YAML 列表写法的 patch 可执行', () => {
    const { commands } = extractCommands(`<json_patch>
- op: replace
  path: /hp
  value: 0
</json_patch>`);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: 'set', args: ['hp', '0'] });
  });
});

describe('pathFix', () => {
  it('裸数字下标保留、引号数字转字符串键、含空格键转 bracket', () => {
    expect(pathFix('a[0]')).toBe('a[0]');
    expect(pathFix('a["0"]')).toBe('a["0"]');
    expect(pathFix('foo."a b".c')).toBe('foo["a b"].c');
    expect(pathFix('foo."武器栏".c')).toBe('foo.武器栏.c');
  });
});

describe('parseParameters', () => {
  it('顶层逗号分割，括号与引号内逗号不分割', () => {
    expect(parseParameters("'a', [1, 2], {x: 1, y: 2}")).toEqual(["'a'", '[1, 2]', '{x: 1, y: 2}']);
    expect(parseParameters("'含,逗号', 1")).toEqual(["'含,逗号'", '1']);
  });
});

// ============================================================================
// 命令执行
// ============================================================================

describe('applyUpdateBlocks — set', () => {
  it('路径存在时更新并出变更记录', () => {
    const result = applyUpdateBlocks({ 好感度: 0 }, "_.set('好感度', 0, 5);//初见");
    expect(result.statData).toEqual({ 好感度: 5 });
    expect(result.changes).toEqual([
      { op: 'set', path: '好感度', from: 0, to: 5, reason: '初见', ok: true },
    ]);
  });

  it('路径不存在时记错误且不改数据', () => {
    const input = { a: 1 };
    const result = applyUpdateBlocks(input, "_.set('不存在', 1);");
    expect(result.statData).toEqual({ a: 1 });
    expect(result.changes[0].ok).toBe(false);
    expect(result.changes[0].error).toContain('不存在');
  });

  it('VWD 只更新第一个元素并保留描述', () => {
    const result = applyUpdateBlocks(
      { 好感度: [0, '对user的好感'] },
      "_.set('好感度', 0, 8);//告白成功",
    );
    expect(result.statData).toEqual({ 好感度: [8, '对user的好感'] });
    expect(result.changes[0]).toMatchObject({ from: 0, to: 8 });
  });

  it('VWD 数字旧值 + 字符串新值强转数字', () => {
    const result = applyUpdateBlocks({ 好感度: [5, '描述'] }, "_.set('好感度', '12');");
    expect(result.statData).toEqual({ 好感度: [12, '描述'] });
  });

  it('普通数字旧值 + 字符串新值强转数字', () => {
    const result = applyUpdateBlocks({ 金币: 10 }, "_.set('金币', '25');");
    expect(result.statData).toEqual({ 金币: 25 });
  });

  it('不可变：输入对象不被修改', () => {
    const input = { 好感度: 0 };
    applyUpdateBlocks(input, "_.set('好感度', 5);");
    expect(input).toEqual({ 好感度: 0 });
  });

  it('无命令时返回原引用', () => {
    const input = { a: 1 };
    const result = applyUpdateBlocks(input, '纯剧情文本，没有任何命令。');
    expect(result.statData).toBe(input);
  });
});

describe('applyUpdateBlocks — add', () => {
  it('数字加 delta（含浮点精度修正）', () => {
    const result = applyUpdateBlocks({ 金币: 10 }, "_.add('金币', 5);//打工");
    expect(result.statData).toEqual({ 金币: 15 });
    const float = applyUpdateBlocks({ x: 0.1 }, "_.add('x', 0.2);");
    expect(float.statData).toEqual({ x: 0.3 });
  });

  it('VWD 数字加 delta', () => {
    const result = applyUpdateBlocks({ 好感度: [3, '描述'] }, "_.add('好感度', 2);");
    expect(result.statData).toEqual({ 好感度: [5, '描述'] });
  });

  it('负 delta（JSONPatch delta 翻译路径）', () => {
    const result = applyUpdateBlocks(
      { stat_data: { 金币: 10 } },
      '<JSONPatch>[{"op":"delta","path":"/stat_data/金币","value":-4}]</JSONPatch>',
    );
    expect(result.statData).toEqual({ stat_data: { 金币: 6 } });
  });

  it('日期按毫秒推进并存 ISO', () => {
    const result = applyUpdateBlocks(
      { 当前时间: '2026-01-01T00:00:00.000Z' },
      "_.add('当前时间', 3600000);//过了一小时",
    );
    expect(result.statData).toEqual({ 当前时间: '2026-01-01T01:00:00.000Z' });
  });

  it('非数字目标记错误', () => {
    const result = applyUpdateBlocks({ 名字: '理' }, "_.add('名字', 1);");
    expect(result.changes[0].ok).toBe(false);
  });
});

describe('applyUpdateBlocks — insert', () => {
  it('双参：数组 push', () => {
    const result = applyUpdateBlocks({ 物品: ['木剑'] }, "_.insert('物品', '盾牌');");
    expect(result.statData).toEqual({ 物品: ['木剑', '盾牌'] });
  });

  it('双参：对象深合并', () => {
    const result = applyUpdateBlocks(
      { 关系: { 理: '朋友' } },
      `_.assign('关系', {"艾拉": "陌生人"});`,
    );
    expect(result.statData).toEqual({ 关系: { 理: '朋友', 艾拉: '陌生人' } });
  });

  it('三参：数组按索引插入与 - 追加（对齐 json patch /- 测试）', () => {
    const spliced = applyUpdateBlocks({ 列表: ['a', 'c'] }, "_.insert('列表', 1, 'b');");
    expect(spliced.statData).toEqual({ 列表: ['a', 'b', 'c'] });
    const appended = applyUpdateBlocks(
      { 主角: { 持有物品: [{ name: '木钥匙' }] } },
      '<JsonPatch>[{"op":"insert","path":"/主角/持有物品/-","value":{"name":"铜钥匙"}}]</JsonPatch>',
    );
    expect(appended.statData).toEqual({ 主角: { 持有物品: [{ name: '木钥匙' }, { name: '铜钥匙' }] } });
  });

  it('三参：对象设新键（JSONPatch insert 容忍缺根斜杠）', () => {
    const result = applyUpdateBlocks(
      { 主角: { 备忘录: {} } },
      '<JSONPatch>[{ "op": "insert", "path": "主角/备忘录/任务", "value": "Day1 露出任务" }]</JSONPatch>',
    );
    expect(result.statData).toEqual({ 主角: { 备忘录: { 任务: 'Day1 露出任务' } } });
    expect(result.statData).not.toHaveProperty('角');
  });

  it('原始类型目标记错误', () => {
    const result = applyUpdateBlocks({ 名字: '理' }, "_.insert('名字', 'x');");
    expect(result.changes[0].ok).toBe(false);
  });

  it('父路径缺失记错误', () => {
    const result = applyUpdateBlocks({ a: 1 }, "_.insert('不存在.深层', 'x');");
    expect(result.changes[0].ok).toBe(false);
  });

  it('目标路径不存在时拒绝（真实验证 1：undefined 也是「原始类型」）——不自动建容器', () => {
    // LLM 极常见写法；真实 MVU 报错跳过，试聊必须一致，否则导出后上真实酒馆全崩
    const twoArg = applyUpdateBlocks({ 背包: {} }, `_.insert('背包.清单', ["药水"]);`);
    expect(twoArg.statData).toEqual({ 背包: {} });
    expect(twoArg.changes[0].ok).toBe(false);
    const threeArg = applyUpdateBlocks({}, "_.insert('新表', '钥匙', 1);");
    expect(threeArg.statData).toEqual({});
    expect(threeArg.changes[0].ok).toBe(false);
  });

  it('目标值为 null 时才自动建容器（对齐真实引擎）', () => {
    const result = applyUpdateBlocks({ 列表: null }, `_.insert('列表', ["x"]);`);
    expect(result.statData).toEqual({ 列表: [['x']] });
    expect(result.changes[0].ok).toBe(true);
  });

  it('对象源并入数组目标：按下标写入、数组身份保留（lodash merge 跨类型语义）', () => {
    const result = applyUpdateBlocks(
      { 角色: { 物品: ['旧剑', '盾'] } },
      `_.insert('角色', {"物品": {"0": "新剑"}});`,
    );
    expect(result.statData).toEqual({ 角色: { 物品: ['新剑', '盾'] } });
    expect(Array.isArray((result.statData.角色 as Record<string, unknown>).物品)).toBe(true);
  });
});

describe('applyUpdateBlocks — delete', () => {
  it('单参数字尾路径：数组 splice 不留洞', () => {
    const result = applyUpdateBlocks({ 物品: ['a', 'b', 'c'] }, "_.delete('物品[1]');");
    expect(result.statData).toEqual({ 物品: ['a', 'c'] });
  });

  it('单参对象路径：整路径删除', () => {
    const result = applyUpdateBlocks({ a: { b: 1, c: 2 } }, "_.remove('a.b');");
    expect(result.statData).toEqual({ a: { c: 2 } });
  });

  it('双参：数组按深等值删除', () => {
    const result = applyUpdateBlocks(
      { 物品: [{ name: '钥匙' }, { name: '盾' }] },
      `_.remove('物品', {"name": "钥匙"});`,
    );
    expect(result.statData).toEqual({ 物品: [{ name: '盾' }] });
  });

  it('双参：对象按键名删除', () => {
    const result = applyUpdateBlocks({ 关系: { 理: '朋友', 艾拉: '敌人' } }, "_.remove('关系', '艾拉');");
    expect(result.statData).toEqual({ 关系: { 理: '朋友' } });
  });

  it('路径不存在记错误', () => {
    const result = applyUpdateBlocks({ a: 1 }, "_.delete('b');");
    expect(result.changes[0].ok).toBe(false);
  });

  it('第二参数解析为 undefined 时拒绝（真实引擎报 Could not determine target），不整路径删除', () => {
    const result = applyUpdateBlocks({ a: { b: 1, c: 2 } }, "_.delete('a.b', undefined);");
    expect(result.statData).toEqual({ a: { b: 1, c: 2 } });
    expect(result.changes[0].ok).toBe(false);
  });
});

describe('applyUpdateBlocks — move（真实引擎为 no-op）', () => {
  it('move 不执行且记警告性错误', () => {
    const input = { a: 1, b: 2 };
    const result = applyUpdateBlocks(
      input,
      '<JSONPatch>[{"op":"move","from":"/a","to":"/b"}]</JSONPatch>',
    );
    expect(result.statData).toEqual({ a: 1, b: 2 });
    expect(result.changes[0].ok).toBe(false);
    expect(result.changes[0].error).toContain('move');
  });
});

// ============================================================================
// YAML 子集
// ============================================================================

describe('parseSimpleYaml', () => {
  it('嵌套映射与标量类型', () => {
    const parsed = parseSimpleYaml(`世界:
  当前日期: 4月4日
  好感度: 10
  已解锁: true
  空值: null`);
    expect(parsed).toEqual({ 世界: { 当前日期: '4月4日', 好感度: 10, 已解锁: true, 空值: null } });
  });

  it('行内数组（VWD 二元组）与引号串', () => {
    const parsed = parseSimpleYaml(`理:
  好感度: [0, "对user的好感度"]
  名字: '理'`);
    expect(parsed).toEqual({ 理: { 好感度: [0, '对user的好感度'], 名字: '理' } });
  });

  it('序列：标量项与对象项', () => {
    const parsed = parseSimpleYaml(`物品:
  - 木剑
  - name: 盾牌
    weight: 3`);
    expect(parsed).toEqual({ 物品: ['木剑', { name: '盾牌', weight: 3 }] });
  });

  it('JSON 内容直接解析（理理式 initvar）', () => {
    const parsed = parseSimpleYaml(`{
  "理": { "好感度": [0, "描述"], "情绪": { "pleasure": 0.1 } }
}`);
    expect(parsed).toEqual({ 理: { 好感度: [0, '描述'], 情绪: { pleasure: 0.1 } } });
  });

  it('注释行忽略、未引号标量的行内注释剥离', () => {
    const parsed = parseSimpleYaml(`# 头注释
金币: 10 # 初始金币
名字: "带 # 的值"`);
    expect(parsed).toEqual({ 金币: 10, 名字: '带 # 的值' });
  });

  it('literal 块（|-）', () => {
    const parsed = parseSimpleYaml(`描述: |-
  第一行
  第二行`);
    expect(parsed).toEqual({ 描述: '第一行\n第二行' });
  });

  it('解析失败抛错（不静默吞掉）', () => {
    expect(() => parseSimpleYaml('{ 不是合法 json')).toThrow();
  });
});

describe('yamlStringify', () => {
  it('标量与嵌套映射', () => {
    expect(yamlStringify(10)).toBe('10');
    expect(yamlStringify('教堂')).toBe('教堂');
    expect(yamlStringify(null)).toBe('null');
    expect(yamlStringify({ 世界: { 日期: '4月4日', 好感: 10 } })).toBe('世界:\n  日期: 4月4日\n  好感: 10');
  });

  it('数组与空容器', () => {
    expect(yamlStringify({ 物品: ['a', 'b'], 空表: [], 空对象: {} })).toBe(
      '物品:\n  - a\n  - b\n空表: []\n空对象: {}',
    );
  });

  it('多行字符串用 literal 块', () => {
    expect(yamlStringify('第一行\n第二行')).toBe('|-\n  第一行\n  第二行');
  });

  it('数字样字符串加引号避免歧义', () => {
    expect(yamlStringify('123')).toBe('"123"');
    expect(yamlStringify('true')).toBe('"true"');
  });

  it('roundtrip：stringify 后 parse 还原', () => {
    const value = { 理: { 好感度: [0, '描述'], 物品: ['钥匙'], 层级: { 深: 1 } } };
    expect(parseSimpleYaml(yamlStringify(value))).toEqual(value);
  });
});

// ============================================================================
// 初始变量
// ============================================================================

function makeCard(overrides: {
  firstMes?: string;
  entries?: Array<{ comment?: string; name?: string; content?: string; enabled?: boolean }>;
}): unknown {
  return {
    data: {
      name: '测试卡',
      first_mes: overrides.firstMes ?? '',
      character_book: { entries: overrides.entries ?? [] },
    },
  };
}

describe('extractSetvarCalls', () => {
  it('解析导出器生成的 setvar 前缀（数字/字符串/布尔）', () => {
    const calls = extractSetvarCalls(
      `<%_ setvar('stat_data.世界.日期', '4月4日'); setvar('stat_data.理.好感度', 0); setvar('stat_data.已解锁', true); _%>\n正文`,
    );
    expect(calls).toEqual([
      { path: '世界.日期', value: '4月4日' },
      { path: '理.好感度', value: 0 },
      { path: '已解锁', value: true },
    ]);
  });

  it('反转义 escapeEjsSingleQuoted 产物', () => {
    const calls = extractSetvarCalls(`<%_ setvar('stat_data.角色.外号', '小\\'理\\''); _%>`);
    expect(calls).toEqual([{ path: '角色.外号', value: "小'理'" }]);
  });

  it('忽略非 stat_data 路径与非字面量路径', () => {
    const calls = extractSetvarCalls(`<%_ setvar('other.x', 1); setvar(pathVar, 2); _%>`);
    expect(calls).toEqual([]);
  });
});

describe('parseInitialVariables', () => {
  it('读取 [initvar] 条目（含禁用的——对齐真实 MVU 不检查 enabled）', () => {
    const card = makeCard({
      entries: [
        { comment: '[InitVar]请勿打开', enabled: false, content: '理:\n  好感度: [0, "描述"]' },
        { comment: '普通条目', content: '不该被读取' },
      ],
    });
    const result = parseInitialVariables(card);
    expect(result.statData).toEqual({ 理: { 好感度: [0, '描述'] } });
    expect(result.sources).toEqual(['[InitVar]请勿打开']);
  });

  it('多条目 correctlyMerge：对象深并、数组整体替换', () => {
    const card = makeCard({
      entries: [
        { comment: '[initvar]1', content: '理:\n  物品: ["a"]\n  好感: 1' },
        { comment: '[initvar]2', content: '理:\n  物品: ["b", "c"]\n  新键: 2' },
      ],
    });
    const result = parseInitialVariables(card);
    expect(result.statData).toEqual({ 理: { 物品: ['b', 'c'], 好感: 1, 新键: 2 } });
  });

  it('剥 <initvar> 包裹与代码围栏', () => {
    const card = makeCard({
      entries: [
        {
          comment: '[initvar]包裹',
          content: '<initvar>\n```yaml\n金币: 10\n```\n</initvar>',
        },
      ],
    });
    expect(parseInitialVariables(card).statData).toEqual({ 金币: 10 });
  });

  it('setvar 覆盖 initvar 基线', () => {
    const card = makeCard({
      firstMes: `<%_ setvar('stat_data.理.好感度', 5); _%>\n开场白正文`,
      entries: [{ comment: '[initvar]', content: '理:\n  好感度: 0\n  名字: 理' }],
    });
    const result = parseInitialVariables(card);
    expect(result.statData).toEqual({ 理: { 好感度: 5, 名字: '理' } });
    expect(result.sources).toContain('开场白 setvar ×1');
  });

  it('开场白 <initvar> 块整体覆盖世界书基线', () => {
    const card = makeCard({
      firstMes: '<initvar>\n金币: 99\n</initvar>\n正文',
      entries: [{ comment: '[initvar]', content: '金币: 1\n名字: 理' }],
    });
    const result = parseInitialVariables(card);
    expect(result.statData).toEqual({ 金币: 99 });
  });

  it('解析失败进 warnings 不抛出', () => {
    const card = makeCard({
      entries: [{ comment: '[initvar]坏', content: '{ 坏 json' }],
    });
    const result = parseInitialVariables(card);
    expect(result.statData).toEqual({});
    expect(result.warnings).toHaveLength(1);
  });
});

// ============================================================================
// 宏替换
// ============================================================================

describe('substituteVariableMacros', () => {
  const statData: StatData = {
    地点: '教堂',
    好感度: 10,
    理: { 心情: '平静', $隐藏: '不可见', 物品: ['钥匙', '书'] },
    $meta: { x: 1 },
    多行: '第一行\n第二行',
  };

  it('get：字符串原样、数字/对象单行 JSON', () => {
    const r1 = substituteVariableMacros('<div>{{get_message_variable::stat_data.地点}}</div>', statData);
    expect(r1.html).toBe('<div>教堂</div>');
    const r2 = substituteVariableMacros('{{get_message_variable::stat_data.好感度}}', statData);
    expect(r2.html).toBe('10');
    const r3 = substituteVariableMacros('{{get_message_variable::stat_data.理}}', statData);
    expect(r3.html).toBe('{"心情":"平静","物品":["钥匙","书"]}');
  });

  it('深度剔除 $ 开头的键（对齐酒馆助手 4.3.9+）', () => {
    const r = substituteVariableMacros('{{get_message_variable::stat_data}}', statData);
    expect(r.html).not.toContain('$隐藏');
    expect(r.html).not.toContain('$meta');
    expect(r.html).toContain('教堂');
  });

  it('format：对象转 YAML 块并按前缀宽度缩进续行（前缀 4 字符 → 缩 4 空格）', () => {
    const r = substituteVariableMacros('状态: {{format_message_variable::stat_data.理}}', statData);
    expect(r.html).toBe('状态: 心情: 平静\n    物品:\n      - 钥匙\n      - 书');
  });

  it('format：字符串原样输出', () => {
    const r = substituteVariableMacros('地点: {{format_message_variable::stat_data.地点}}', statData);
    expect(r.html).toBe('地点: 教堂');
  });

  it('同一行多个 format 宏都生效（对齐酒馆助手 4.3.19 修复）', () => {
    const r = substituteVariableMacros(
      '{{format_message_variable::stat_data.地点}} | {{format_message_variable::stat_data.好感度}}',
      statData,
    );
    expect(r.html).toBe('教堂 | 10');
  });

  it('get 先于 format 替换（对齐真实 macros 数组顺序）：format 续行按已替换前缀宽度缩进', () => {
    // 前缀 '❤教堂 ' = 4 个 UTF-16 单元 → 续行缩 4 空格；若 format 先跑，
    // 前缀里还是 get 宏原文（40+ 字符），YAML 块会整体右漂
    const r = substituteVariableMacros(
      '❤{{get_message_variable::stat_data.地点}} {{format_message_variable::stat_data.理}}',
      statData,
    );
    expect(r.html).toBe('❤教堂 心情: 平静\n    物品:\n      - 钥匙\n      - 书');
  });

  it('路径不做 trim：尾随空格的路径进 unresolved（真实运行时渲染 null，宏是坏的）', () => {
    const r = substituteVariableMacros('{{get_message_variable::stat_data.好感度 }}', statData);
    expect(r.html).toBe('{{get_message_variable::stat_data.好感度 }}');
    expect(r.unresolved).toHaveLength(1);
  });

  it('路径不存在：保留宏原样并计入 unresolved（刻意偏离真实 "null"）', () => {
    const r = substituteVariableMacros('{{get_message_variable::stat_data.不存在}}', statData);
    expect(r.html).toBe('{{get_message_variable::stat_data.不存在}}');
    expect(r.unresolved).toEqual(['{{get_message_variable::stat_data.不存在}}']);
  });

  it('非 message 类型保留原样并计入 unresolved', () => {
    const r = substituteVariableMacros('{{get_global_variable::stat_data.地点}}', statData);
    expect(r.html).toContain('get_global_variable');
    expect(r.unresolved).toHaveLength(1);
  });

  it('路径做 HTML 实体反转义', () => {
    const withEntity: StatData = { 'a<b': 1 };
    const r = substituteVariableMacros('{{get_message_variable::stat_data.a&lt;b}}', withEntity);
    expect(r.html).toBe('1');
  });

  it('存在但值为 null 的路径渲染 null（区别于缺失路径）', () => {
    const r = substituteVariableMacros('{{get_message_variable::stat_data.空}}', { 空: null });
    expect(r.html).toBe('null');
    expect(r.unresolved).toHaveLength(0);
  });
});

describe('omitDollarKeysDeep', () => {
  it('数组内对象同样剔除', () => {
    expect(omitDollarKeysDeep([{ $a: 1, b: 2 }])).toEqual([{ b: 2 }]);
  });
});

// ============================================================================
// 显示后处理
// ============================================================================

describe('applyMvuDisplayPostProcess', () => {
  it('补占位符（缺失时）且不重复补', () => {
    expect(applyMvuDisplayPostProcess('回复正文', { appendPlaceholder: true })).toBe(
      '回复正文\n\n<StatusPlaceHolderImpl/>',
    );
    expect(
      applyMvuDisplayPostProcess('正文\n<StatusPlaceHolderImpl/>', { appendPlaceholder: true }),
    ).toBe('正文\n<StatusPlaceHolderImpl/>');
  });

  it('appendPlaceholder=false 时不补', () => {
    expect(applyMvuDisplayPostProcess('正文', { appendPlaceholder: false })).toBe('正文');
  });

  it('删除 <status_current_variable> 块（对齐 handleVariablesInMessage）', () => {
    const out = applyMvuDisplayPostProcess(
      '前<status_current_variable>{"a":1}</status_current_variable>后',
      { appendPlaceholder: false },
    );
    expect(out).toBe('前后');
  });

  it('删除纯 setvar 的 EJS 块、保留其他 EJS', () => {
    const out = applyMvuDisplayPostProcess(
      `<%_ setvar('stat_data.a', 1); setvar('stat_data.b', 'x'); _%>\n正文 <%- getvar('stat_data.a') %>`,
      { appendPlaceholder: false },
    );
    expect(out).toBe(`\n正文 <%- getvar('stat_data.a') %>`);
  });

  it('占位符判定先于删块（对齐真实顺序）：占位符只在 <status_current_variable> 块内时不补', () => {
    // 真实运行时：includes 命中 → 不补 → 删块把占位符一起删掉 → 状态栏不渲染。
    // 若先删块再判定，会误补一个占位符、试聊里状态栏照常渲染，与导出后行为分叉。
    const out = applyMvuDisplayPostProcess(
      '正文\n<status_current_variable>\n<StatusPlaceHolderImpl/>\n</status_current_variable>',
      { appendPlaceholder: true },
    );
    expect(out).not.toContain('<StatusPlaceHolderImpl/>');
  });

  it('stripStatusCurrentVariable：提示词通道剥离变量转储块', () => {
    expect(stripStatusCurrentVariable('前<status_current_variable>hp: 10</status_current_variable>后')).toBe('前后');
    expect(stripStatusCurrentVariable('无块文本')).toBe('无块文本');
  });
});

// ============================================================================
// 时间线
// ============================================================================

describe('buildVariableTimeline', () => {
  const card = makeCard({
    firstMes: `<%_ setvar('stat_data.好感度', 0); setvar('stat_data.金币', 10); _%>\n「你好。」`,
  });

  it('初始值 → 逐消息演进 → 快照对齐', () => {
    const timeline = buildVariableTimeline(card, [
      { role: 'assistant', content: `<%_ setvar('stat_data.好感度', 0); setvar('stat_data.金币', 10); _%>\n「你好。」` },
      { role: 'user', content: '我请你喝茶。' },
      {
        role: 'assistant',
        content: '「谢谢。」\n<UpdateVariable>\n<JSONPatch>[{"op":"delta","path":"/好感度","value":3},{"op":"replace","path":"/金币","value":8}]</JSONPatch>\n</UpdateVariable>',
      },
    ]);
    expect(timeline.active).toBe(true);
    expect(timeline.init.statData).toEqual({ 好感度: 0, 金币: 10 });
    expect(timeline.snapshots[0]).toEqual({ 好感度: 0, 金币: 10 });
    expect(timeline.snapshots[1]).toEqual({ 好感度: 0, 金币: 10 });
    expect(timeline.snapshots[2]).toEqual({ 好感度: 3, 金币: 8 });
    expect(timeline.changesByMessage[2]).toHaveLength(2);
  });

  it('重 roll 回滚 = 截断消息后重放', () => {
    const messages = [
      { role: 'assistant', content: card ? (card as { data: { first_mes: string } }).data.first_mes : '' },
      { role: 'user', content: '打招呼' },
      { role: 'assistant', content: '「嗯。」\n<JSONPatch>[{"op":"delta","path":"/好感度","value":5}]</JSONPatch>' },
    ];
    const full = buildVariableTimeline(card, messages);
    expect(full.snapshots[2]).toEqual({ 好感度: 5, 金币: 10 });
    const rerolled = buildVariableTimeline(card, messages.slice(0, 2));
    expect(rerolled.snapshots[1]).toEqual({ 好感度: 0, 金币: 10 });
  });

  it('用户消息里的命令同样执行（真实 MVU 允许手动作弊）', () => {
    const timeline = buildVariableTimeline(card, [
      { role: 'assistant', content: (card as { data: { first_mes: string } }).data.first_mes },
      { role: 'user', content: "_.set('金币', 999);//作弊" },
    ]);
    expect(timeline.snapshots[1]).toEqual({ 好感度: 0, 金币: 999 });
  });

  it('assistant 短消息（<5 字符）跳过——移植真实怪癖', () => {
    const timeline = buildVariableTimeline(card, [
      { role: 'assistant', content: '嗯。' },
    ]);
    expect(timeline.changesByMessage[0]).toEqual([]);
  });

  it('无 MVU 结构的卡 active=false', () => {
    const plain = makeCard({ firstMes: '普通开场白' });
    const timeline = buildVariableTimeline(plain, [{ role: 'assistant', content: '普通开场白' }]);
    expect(timeline.active).toBe(false);
  });
});

// ============================================================================
// 杂项
// ============================================================================

// ============================================================================
// 安全：原型污染防线（6 条实测可达向量的回归）
// ============================================================================

describe('原型污染防线', () => {
  // 断言一律在**新建的空对象**上做——「污染了克隆体」不算通过
  const pristine = () => ({}) as Record<string, unknown>;

  afterEach(() => {
    // 万一某条用例真的污染了，别让它渗进后面的用例/其他测试文件
    for (const key of ['polluted', 'pwn', 'pollutedSV', 'disabled']) {
      delete (Object.prototype as Record<string, unknown>)[key];
    }
  });

  it('向量1 _.insert 两参合并进 __proto__：拒绝且全局原型干净', () => {
    const result = applyUpdateBlocks({}, `_.insert('__proto__', {"polluted":"yes"});`);
    expect(pristine().polluted).toBeUndefined();
    expect(result.changes[0].ok).toBe(false);
  });

  it('向量2 _.insert 三参写 __proto__：拒绝且全局原型干净', () => {
    const result = applyUpdateBlocks({}, "_.insert('__proto__', 'pwn', 1);");
    expect(pristine().pwn).toBeUndefined();
    expect(result.changes[0].ok).toBe(false);
  });

  it('向量3 JSONPatch add /__proto__/pwn：拒绝且全局原型干净', () => {
    const result = applyUpdateBlocks(
      {},
      '<json_patch>[{"op":"add","path":"/__proto__/pwn","value":42}]</json_patch>',
    );
    expect(pristine().pwn).toBeUndefined();
    expect(result.changes[0].ok).toBe(false);
  });

  it('向量4 [InitVar] 条目里的自有 __proto__ 键：不污染全局', () => {
    const card = makeCard({
      entries: [{ comment: '[initvar]', content: '{"__proto__":{"polluted":"init"},"好感度":0}' }],
    });
    const result = parseInitialVariables(card);
    expect(pristine().polluted).toBeUndefined();
    expect(result.statData.好感度).toBe(0);
  });

  it('向量5 开场白 setvar 走 __proto__ 路径：不污染全局', () => {
    const card = makeCard({
      firstMes: `<%_ setvar('stat_data.__proto__.pollutedSV', 'PWNED'); _%>\n正文`,
    });
    parseInitialVariables(card);
    expect(pristine().pollutedSV).toBeUndefined();
  });

  it('向量6 已存在对象的 __proto__ 子路径：拒绝且全局原型干净', () => {
    const result = applyUpdateBlocks({ 角色: {} }, `_.insert('角色.__proto__', {"polluted":"nested"});`);
    expect(pristine().polluted).toBeUndefined();
    expect(result.changes[0].ok).toBe(false);
  });

  it('_.set 到 __proto__ 路径同样拒绝（hasAtPath 只认自有键）', () => {
    const result = applyUpdateBlocks({}, "_.set('__proto__.disabled', true);");
    expect(pristine().disabled).toBeUndefined();
    expect(result.changes[0].ok).toBe(false);
  });

  it('_.delete 不能剥掉真实原型上的方法', () => {
    applyUpdateBlocks({}, "_.delete('__proto__.toString');");
    expect(typeof ({}).toString).toBe('function');
  });

  it('getAtPath/hasAtPath 不把 __proto__ 当容器', () => {
    expect(getAtPath({ a: 1 }, '__proto__')).toBeUndefined();
    expect(hasAtPath({ a: 1 }, '__proto__')).toBe(false);
    expect(hasAtPath({ a: 1 }, 'constructor')).toBe(false);
  });

  it('污染不跨调用残留：后续 applyUpdateBlocks 的结果对象干净', () => {
    applyUpdateBlocks({}, "_.insert('__proto__', 'pwn', 'sticky');");
    const after = applyUpdateBlocks({ x: 1 }, '普通文本');
    expect((after.statData as Record<string, unknown>).pwn).toBeUndefined();
    expect(pristine().pwn).toBeUndefined();
  });
});

// ============================================================================
// 安全：拒绝服务 / 栈溢出（恶意输入不得冻结主线程或掀翻整站）
// ============================================================================

describe('恶意输入的时间与深度上界', () => {
  it('SETVAR_ONLY_RE 不再指数回溯：30 个 setvar + 尾随字符瞬间返回', () => {
    const evil = '<% ' + "setvar('a',1);".repeat(30) + 'X %>';
    const start = Date.now();
    const out = applyMvuDisplayPostProcess(evil, { appendPlaceholder: false });
    expect(Date.now() - start).toBeLessThan(1000);
    // 非纯 setvar 块（末尾有 X）保持原样，不删
    expect(out).toContain('X');
  });

  it('大量未闭合 _.set( 有扫描预算，不会二次爆炸', () => {
    const evil = '_.set('.repeat(20000);
    const start = Date.now();
    const { commands, warnings } = extractCommands(evil);
    expect(Date.now() - start).toBeLessThan(3000);
    expect(commands).toHaveLength(0);
    expect(warnings.some((w) => w.includes('预算'))).toBe(true);
  });

  it('单行数千个 format 宏不再爆栈（迭代扫描取代递归）', () => {
    const line = '{{format_message_variable::stat_data.a}}'.repeat(5000);
    expect(() => substituteVariableMacros(line, { a: '值' })).not.toThrow();
    expect(substituteVariableMacros(line, { a: 'x' }).html).toBe('x'.repeat(5000));
  });

  it('未闭合 format 起始标记的超长行不卡死', () => {
    const evil = '{{format_message_variable::'.repeat(20000);
    const start = Date.now();
    expect(() => substituteVariableMacros(evil, { a: 1 })).not.toThrow();
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('深嵌套值降级为字符串，不进 stat_data（防 deepClone/yamlStringify 爆栈）', () => {
    const deep = '['.repeat(3000) + ']'.repeat(3000);
    // 旧值用字符串：数字旧值会走真实 MVU 的「字符串新值强转数字」分支（结果 NaN），
    // 那条语义与本用例要验证的深度防线无关
    const result = applyUpdateBlocks({ 记录: '' }, `_.set('记录', ${deep});`);
    expect(typeof result.statData.记录).toBe('string');
    // 下游序列化不再抛 RangeError
    expect(() => yamlStringify(result.statData)).not.toThrow();
  });

  it('深嵌套 initvar 条目被拒绝并给出警告', () => {
    const card = makeCard({
      entries: [{ comment: '[initvar]', content: `{"a":${'['.repeat(3000)}${']'.repeat(3000)}}` }],
    });
    const result = parseInitialVariables(card);
    expect(result.statData).toEqual({});
    expect(result.warnings.some((w) => w.includes('嵌套过深'))).toBe(true);
  });

  it('exceedsDepth 本身是迭代的，对超深结构不爆栈', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 10000; i++) deep = [deep];
    expect(() => exceedsDepth(deep)).not.toThrow();
    expect(exceedsDepth(deep)).toBe(true);
    expect(exceedsDepth({ a: { b: 1 } })).toBe(false);
  });
});

describe('trimQuotesAndBackslashes', () => {
  it('去首尾引号/反引号/反斜杠/空格', () => {
    expect(trimQuotesAndBackslashes("'abc'")).toBe('abc');
    expect(trimQuotesAndBackslashes('` x `')).toBe('x');
    expect(trimQuotesAndBackslashes('\\"y\\"')).toBe('y');
  });

  it('多行输入不剥壳（与真实正则无 s 标志一致）', () => {
    expect(trimQuotesAndBackslashes('`a\nb`')).toBe('`a\nb`');
  });
});
