@echo off
REM ===== AI 聊天 API (DeepSeek Anthropic 兼容端点) =====
set AI_API_KEY=你的DeepSeek_API_Key
set AI_API_BASE_URL=https://api.deepseek.com/anthropic
set AI_MODEL=deepseek-chat
set AI_MODELS=deepseek-chat,openai/gpt-image-2/text-to-image

REM ===== AI 图片生成 API (AtlasCloud GPT Image 2) =====
set IMAGE_API_KEY=你的AtlasCloud_API_Key
set IMAGE_API_BASE_URL=https://api.atlascloud.ai/api/v1
set IMAGE_MODEL=openai/gpt-image-2/text-to-image

node server.js
