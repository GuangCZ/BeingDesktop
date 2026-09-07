'use strict';

// Editorial summaries describe the public catalog; they do not certify a kit.
(() => {
  const entries = [
    ['being-search','网络搜索 · 搜索互联网并读取网页正文。','知识',['搜索互联网','读取相关网页正文']],
    ['being-browse','网页读取 · 读取公开网页，支持 JavaScript 渲染。','知识',['读取公开网页','渲染 JavaScript 页面']],
    ['djBmkam0yEsghxAoVEeij','查看屏幕、点击与输入，操作浏览器和 macOS 应用。','工具',['查看图形界面中的内容','在浏览器中点击与输入','连接支持的原生应用']],
    ['CSTVnvnA2sskgO78k4jLT','创建、观察和调度 prime-agent 编程任务。','开发',['创建和提示 Agent','观察任务过程','调整或结束任务']],
    ['kk8L95lcA477s4Fy7KdRo','汇总每周工作，理清依赖与团队下一步。','协作',['整理分散的工作信息','识别任务之间的依赖','形成有依据的周度协同计划']],
    ['OteJGwtOzLqL7jmyZ2PfM','运行可持续跟踪的异步 Codex CLI 任务。','开发',['启动异步编程任务','持续跟踪任务状态','通过 Heart Portal 管理任务']],
    ['op993xqkvii9fyg1V2AQX','通过 Cursor Agent SDK 创建与管理编程 Agent。','开发',['创建编程 Agent','向 Agent 发送任务','管理 Agent 会话']],
    ['KfziINBBnDpxLVZlfdsKc','搜索与阅读网页、GitHub、YouTube 和 RSS。','工具',['搜索互联网内容','读取网页和代码信息','获取视频与订阅源内容']],
    ['3m39hKPimCtOJ2MQhXLCB','连接 Codex 会话，浏览网页、编程与读取文件。','开发',['运行完整 Codex 会话','浏览网页与执行代码','读取任务所需文件']],
    ['W1nK_PzrkDTLj7UGvd741','用 opencode 探索文件、生成代码并执行任务。','开发',['探索项目文件','生成和修改代码','运行并跟踪 Agent 任务']],
    ['zdVdrI5rNEkaENW9nv5aH','搜索和更新 Jira 事项，管理项目与迭代。','协作',['搜索和创建事项','更新事项内容','管理 Sprint 与项目']],
    ['7vWqrnJgSP9gx--45zV2b','使用飞书文档、表格、评论与办公协作工具。','协作',['读取和编辑飞书文档','操作表格与评论','查询办公工具的使用说明']],
    ['jM-oec68MUWwUdF8yLjO8','通过 Claude Agent SDK 创建与管理编程 Agent。','开发',['创建编程 Agent','发送任务与后续消息','管理 Agent 会话']],
    ['rOl4C7kM8Le_mTLhpFuj4','查询和管理 Linear 中的工作事项。','协作',['查询工作事项','更新与管理事项']],
    ['LPkkQgSHO0LDTdTEWchhi','从内容、品牌与 SEO 三个方面审核文章。','知识',['判断文章的读者价值','核对品牌表达','检查 SEO 并给出发布建议']],
    ['L-pU4FHlquPPPOZyDiKek','连接 Codex 会话，浏览网页、编程与读取文件。','开发',['运行完整 Codex 会话','浏览网页与执行代码','读取任务所需文件']],
    ['TAYvq0_YCoEKQqV4PjzGp','在 Windows、macOS 和 Linux 连接 Codex。','开发',['运行跨平台 Codex 会话','浏览网页与执行代码','读取任务所需文件']],
    ['MMfnXR7ZlRrN5n94vJIFz','校验、打包和发布可复用的 Grove 工具包。','开发',['整理工具包清单','校验字段并打包','发布和验证工具包']],
    ['1NwzlLWvAcZ7SWZN5wrjR','设计事件埋点，审查数据结构与统计口径。','知识',['从需求推导埋点事件','组织事件与字段结构','审计已有埋点设计']],
    ['kNsAvkCbnuSb51mPGbN2F','发布者尚未提供用途说明。','其他',[]],
    ['sPMxKLaRkdAKjR2knSM7s','整理产品信号、排优先级、写 PRD 与排期。','协作',['整理需求信号','评估优先级并安排计划','撰写产品需求文档']],
    ['MOroXWBIef44npSEjIiac','维护用户手册、更新日志与产品发版说明。','知识',['编写面向用户的手册','整理更新日志与发版稿','统一信息结构与中英文表达']],
    ['cPXPSeA3qwOvDH2dFQhsG','整理产品事实，构建可供 AI 引用的知识库。','知识',['导入与查询产品事实','检查知识库内容一致性','记录维护与修正过程']],
  ];
  const productBrands = {
    OteJGwtOzLqL7jmyZ2PfM: 'codex', '3m39hKPimCtOJ2MQhXLCB': 'codex',
    'L-pU4FHlquPPPOZyDiKek': 'codex', TAYvq0_YCoEKQqV4PjzGp: 'codex',
    op993xqkvii9fyg1V2AQX: 'cursor', W1nK_PzrkDTLj7UGvd741: 'opencode',
    zdVdrI5rNEkaENW9nv5aH: 'jira', '7vWqrnJgSP9gx--45zV2b': 'feishu',
    'jM-oec68MUWwUdF8yLjO8': 'claude', rOl4C7kM8Le_mTLhpFuj4: 'linear',
  };
  const themedBrands = new Set(['cursor', 'opencode', 'linear']);
  const catalog = Object.fromEntries(entries.map(([id,description,category,capabilities])=>{
    const brand = productBrands[id] || '';
    const asset = brand ? `assets/brands/${brand}${themedBrands.has(brand) ? '-dark' : ''}.${brand === 'codex' ? 'png' : 'svg'}` : `assets/kit-symbols/${id}.svg`;
    const iconLight = themedBrands.has(brand) ? `assets/brands/${brand}-light.svg` : asset;
    return [id,Object.freeze({description,category,capabilities:Object.freeze(capabilities),brand,icon:asset,iconLight,iconStyle:brand ? 'brand' : 'symbol'})];
  }));
  if (typeof module !== 'undefined' && module.exports) module.exports=Object.freeze(catalog);
  else window.groveKitCatalog=Object.freeze(catalog);
})();
