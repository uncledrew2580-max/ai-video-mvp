# TikTok 电商 AI 短视频工作流使用说明

## 1. 系统目标
这套系统不是单一的 AI 生视频工具，而是一条面向 TikTok 电商内容生产的工程流水线。它的核心原则是：

数据库或本地上下文存储
→ 每次调用前重建上下文
→ 调用当前阶段模型
→ 保存中间结果
→ 下一阶段继续读取和组装

## 2. 当前主流程分层
1. Stage 0：Form 输入标准化
2. Stage 1：产品分析 + 创意方向生成
3. Stage 2：人工选择创意方向
4. Stage 3：镜头脚本表格生成
5. Stage 4：NanoBanana 总 Prompt 生成
6. Stage 5：NanoBanana 生成完整宫格分镜图
7. Stage 6：裁切 scene 图片
8. Stage 7：Video Clip Prompt 生成
9. Stage 8：视频模型生成单镜头视频
10. Stage 9：最终视频素材合并
11. Stage 10：结果落盘、记录、可重跑

## 3. Form 表单字段如何约束后续模型
以下字段是业务硬约束，不是参考建议：
- `product_name`
- `product_selling_points`
- `target_market`
- `target_language`
- `creative_task_type`
- `product_images`

其中 `creative_task_type` 是最高优先级字段之一。只有它为空，或显式选择“自动判断”，才允许模型自行补充判断视频类型。

## 4. creative_task_type_mapping 如何维护
维护文件：
[config/creative_task_type_mapping.json](/Users/drew/Downloads/tiktok-n8n-workflow-pack/config/creative_task_type_mapping.json)

你主要会改：
- `video_type`
- `style`
- `script_focus`
- `voiceover_required`
- `visual_focus`
- `avoid`
- `recommended_grid`

不要删除键名本身，否则上下游 context builder 会失配。

## 5. Prompt 文件对应关系
提示词文件目录：
[/Users/drew/Downloads/tiktok-n8n-workflow-pack/prompts](/Users/drew/Downloads/tiktok-n8n-workflow-pack/prompts)

对应关系：
- `00_director_system_prompt.txt`：导演层系统规则
- `01_concept_generation_prompt.txt`：Stage 1 创意方向生成
- `02_script_table_prompt.txt`：Stage 3 镜头脚本生成
- `03_nanobanana_storyboard_prompt.txt`：Stage 4 NanoBanana 总 Prompt
- `04_video_clip_prompt.txt`：Stage 7 Video Clip Prompt
- `05_voiceover_prompt.txt`：目标语言口播
- `negative_prompt_common.txt`：通用负面词
- `consistency_rules_prompt.txt`：人物与产品连续性底线
- `localization_rules_prompt.txt`：目标国家与语言本地化规则

## 6. 哪些 Prompt 可以微调
可以改：
- Hook 风格
- 视频类型与 UGC 强度
- 不同国家本地化表达
- 不同产品类目的额外规则
- CTA 强度
- motion、camera、真实性提示
- 6/9 宫格判断偏好

不要乱改：
- 输出 JSON 结构
- “必须英文”的生成类 Prompt 约束
- no text / no UI / no watermark
- 一镜一视频的工程结构
- Form 硬约束
- selected_concept 硬约束

## 7. 为什么每次调用模型都要重新组装上下文
因为 API 调用没有记忆。模型不会自动记住上一轮输入，所以每一轮必须由工程侧重新传：
- 当前阶段所需图片
- 当前阶段所需文字上下文
- Form 业务硬约束
- 人工选择结果
- 当前任务指令
- 目标输出结构

## 8. 为什么每次调用都要继续带产品图片
因为产品图片是“产品一致性”的最强锚点。只传文字，后续非常容易发生：
- 产品颜色变化
- 材质变化
- 结构变化
- 使用方式变化
- 人物 / 产品连续性断裂

## 9. 为什么 NanoBanana Prompt 必须英文
因为图像生成模型在英文提示词上的训练语料、稳定性和细节命中更强。UI 和状态页可以中文，但 NanoBanana Prompt、Negative Prompt、Video Clip Prompt、Avoid Rules 必须英文。

## 10. 为什么 Video Prompt 必须英文
与生图同理。图生视频模型在英文指令上更稳定，尤其是：
- movement amplitude
- first frame usage
- continuity
- no text / no watermark
- hand/body/product consistency

## 11. 什么时候用 6 宫格
适合：
- 动作简单
- 卖点少
- 短平快展示
- 主要测试 Hook / 核心卖点
- 希望降低生成难度，提高一致性

## 12. 什么时候用 9 宫格
适合：
- 卖点多
- 需要完整使用过程
- 多场景 / 前后对比
- 叙事更复杂
- Hook → Educate → Convert 链条更长

## 13. 创作任务类型如何影响创意方向
它不是建议，而是硬约束。

例子：
- `种草口播`：创意方向必须围绕本地 creator 分享感
- `沉浸式开箱`：创意方向必须围绕手部、包装、细节、节奏
- `产品卖点展示`：创意方向必须优先承接卖点证明与场景展示

## 14. 如何重跑某一个阶段
原则：
1. 找到该阶段对应的本地上下文 JSON 或进度文件
2. 只重跑该阶段及其后续最小必需节点
3. 不要把前面无关阶段全量重跑

常用目录：
- review context：[/Users/drew/Downloads/tiktok-n8n-workflow-pack/.n8n-local-cache/review-context](/Users/drew/Downloads/tiktok-n8n-workflow-pack/.n8n-local-cache/review-context)
- review progress：[/Users/drew/Downloads/tiktok-n8n-workflow-pack/.n8n-local-cache/review-progress](/Users/drew/Downloads/tiktok-n8n-workflow-pack/.n8n-local-cache/review-progress)
- storyboard / Nano cache：[/Users/drew/Downloads/tiktok-n8n-workflow-pack/.n8n-local-cache/nanobanana](/Users/drew/Downloads/tiktok-n8n-workflow-pack/.n8n-local-cache/nanobanana)
- scene upload cache：[/Users/drew/Downloads/tiktok-n8n-workflow-pack/.n8n-local-cache/wavespeed-scenes](/Users/drew/Downloads/tiktok-n8n-workflow-pack/.n8n-local-cache/wavespeed-scenes)

## 15. 如何只重跑某一个 scene 视频
优先使用状态页里的“只重跑失败镜头”。  
后续如果要精细到单 scene，原则上只需要重传：
- 当前 scene_image_url
- 当前 scene_script_json
- 当前 selected_concept
- 当前 product consistency rules
- 当前 video provider config

## 16. 如何更换视频模型
抽象字段统一使用：
- `video_provider`
- `video_model`
- `video_prompt`
- `video_first_frame`
- `scene_video`

当前优先模型配置要从 provider config 切换，而不是重写主流程。  
图生视频只要保持统一接口：
`submit -> poll -> download`
就可以在 `WaveSpeed / Veo / Seedance / Sora / Kling / Wan` 之间切换。

## 17. 如何查看每次调用的 input / output / error
建议保留：
- execution logs
- context pack
- prompt version
- raw request / raw response
- error_message

当前可重点检查：
- n8n 执行页
- review progress JSON
- 本地 request cache
- 本地 response cache

## 18. 如何给不同产品类目做 Prompt 微调
不要把产品类目写死到主流程。  
正确方式：
1. 先让模型在 Stage 1 基于产品图片识别产品类型
2. 再在 Prompt 可微调段里追加该类目规则
3. 保持主框架与 JSON 输出结构不变

## 19. 如何给不同目标市场做本地化微调
主要调这些地方：
- `localization_rules_prompt.txt`
- `creative_task_type_mapping.json`
- `05_voiceover_prompt.txt`

调整目标：
- 生活场景
- 口语风格
- creator 气质
- CTA 语气
- 内容节奏

## 20. 如何检查产品一致性和人物一致性
重点看：
- scene 图片是否与产品原图一致
- 产品颜色 / 材质 / 结构是否漂移
- 人物脸、体型、穿着是否漂移
- 是否出现字幕、UI、水印
- 视频是否大动作导致产品变形

一致性底线文本在：
[prompts/consistency_rules_prompt.txt](/Users/drew/Downloads/tiktok-n8n-workflow-pack/prompts/consistency_rules_prompt.txt)

## 21. 当前工程重点
当前不要推翻：
- NanoBanana 调用
- 分镜裁切
- 图生视频调用
- 本地落盘

下一步优先增强：
1. 创意方向人工选择
2. selected_concept 存储
3. 每阶段 Context Builder
4. Prompt 模块化
5. provider 抽象
6. execution / context / prompt version 追踪
