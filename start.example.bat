@echo off
REM ===== AI 聊天 API (DeepSeek Anthropic 兼容端点) =====
set AI_API_KEY=你的DeepSeek_API_Key
set AI_API_BASE_URL=https://api.deepseek.com/anthropic
set AI_MODEL=deepseek-chat

REM ===== AI 图片生成 API (通义千问 Qwen-Image-2.0) =====
set QWEN_API_KEY=你的Qwen_API_Key
set QWEN_API_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
set QWEN_MODEL=qwen-image-2.0

REM ===== 模型列表 =====
set AI_MODELS=deepseek-chat,qwen-image-2.0,qwen-image-edit-plus,openai/gpt-image-2/text-to-image

REM ===== 图片生成模型（走文生图/编辑API） =====
set IMAGE_MODELS=qwen-image-2.0,qwen-image-edit-plus,openai/gpt-image-2/text-to-image

REM ===== AI 图片生成 API (AtlasCloud GPT Image 2) =====
set IMAGE_API_KEY=你的AtlasCloud_API_Key
set IMAGE_API_BASE_URL=https://api.atlascloud.ai/api/v1
set IMAGE_MODEL=openai/gpt-image-2/text-to-image

node server.js
