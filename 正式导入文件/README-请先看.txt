导入顺序：
1. 01-主流程-表单到创意方向.json
2. 02-续跑-创意方向到分镜.json
3. 03-续跑-分镜审核到视频.json

说明：
- 不要导入 版本迭代使用.backup-*.json，那些是历史备份。
- 版本迭代使用.json 是总包，命令行导入可用；n8n 网页导入请使用本文件夹里的三个单独 JSON。
- 03 工作流当前是 simplified-v1 稳定版：只用 panel_image_path + video_prompt 生成视频，不包含 TTS、mp3、scene-audio 或音频合成逻辑。
- 导入后需要把三个 workflow 都切到 Active。
- 如果 webhook 不工作，运行：node repair_active_workflow_versions.mjs，然后重启 n8n。
