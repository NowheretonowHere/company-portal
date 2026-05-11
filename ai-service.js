const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_API_BASE_URL = process.env.AI_API_BASE_URL || 'https://api.openai.com/v1';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
const AI_SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT || '你是一个有帮助的AI助手。请用中文回答用户的问题。';

// 图片生成 API 配置（独立于聊天 API）
const IMAGE_API_KEY = process.env.IMAGE_API_KEY || AI_API_KEY;
const IMAGE_API_BASE_URL = process.env.IMAGE_API_BASE_URL || AI_API_BASE_URL;
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gpt-image-2';

// 检测 API 格式：URL 含 "anthropic" 则用 Anthropic 格式
const isAnthropic = AI_API_BASE_URL.includes('anthropic');

/**
 * Chat completion — 自动适配 OpenAI / Anthropic 两种 API 格式。
 */
async function chat(messages, options = {}) {
  if (!AI_API_KEY) {
    throw new Error('AI_API_KEY 未配置，请联系管理员设置环境变量');
  }

  const model = options.model || AI_MODEL;

  if (isAnthropic) {
    return chatAnthropic(messages, model, options);
  }
  return chatOpenAI(messages, model, options);
}

/**
 * OpenAI 兼容格式 (OpenAI / DeepSeek / vLLM 等)
 */
async function chatOpenAI(messages, model, options) {
  const requestBody = {
    model,
    messages: [
      { role: 'system', content: AI_SYSTEM_PROMPT },
      ...messages
    ],
    temperature: options.temperature ?? 0.7,
    max_tokens: options.max_tokens ?? 2000
  };

  const response = await fetch(`${AI_API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI_API_KEY}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI API 错误 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return {
    content: data.choices[0].message.content,
    model: data.model,
    usage: data.usage
  };
}

/**
 * Anthropic Messages API 格式 (Claude / DeepSeek Anthropic 兼容端点)
 */
async function chatAnthropic(messages, model, options) {
  const requestBody = {
    model,
    system: AI_SYSTEM_PROMPT,
    messages: messages,
    max_tokens: options.max_tokens ?? 2000,
    temperature: options.temperature ?? 0.7
  };

  const response = await fetch(`${AI_API_BASE_URL}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': AI_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI API 错误 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return {
    content: data.content[0].text,
    model: data.model,
    usage: data.usage
  };
}

/**
 * Generate image (Text-to-Image) — AtlasCloud / OpenAI 兼容格式。
 * 使用独立的 IMAGE_API_KEY 和 IMAGE_API_BASE_URL 配置。
 * 模型: openai/gpt-image-2/text-to-image
 */
async function generateImage(prompt, options = {}) {
  if (!IMAGE_API_KEY) {
    throw new Error('IMAGE_API_KEY 未配置，请联系管理员设置环境变量');
  }

  const requestBody = {
    model: options.model || IMAGE_MODEL,
    prompt: prompt,
    size: options.size || '1024x1024',
    n: options.n || 1,
    quality: options.quality || 'medium',
    output_format: options.output_format || 'jpeg',
    enable_sync_mode: options.enable_sync_mode ?? true,
    enable_base64_output: options.enable_base64_output ?? false
  };

  const response = await fetch(`${IMAGE_API_BASE_URL}/model/generateImage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${IMAGE_API_KEY}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`图片生成 API 错误 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return {
    model: data.model,
    images: (data.data || []).map(img => ({
      url: img.url,
      b64Json: img.b64_json,
      revisedPrompt: img.revised_prompt
    }))
  };
}

/**
 * Edit image — AtlasCloud GPT Image 2 Edit。
 * 模型: openai/gpt-image-2/edit
 * @param {Array<string>} images - 图片 URL 或 base64 数组
 * @param {string} prompt - 编辑指令
 * @param {Object} options
 */
async function editImage(images, prompt, options = {}) {
  if (!IMAGE_API_KEY) {
    throw new Error('IMAGE_API_KEY 未配置，请联系管理员设置环境变量');
  }
  if (!images || images.length === 0) {
    throw new Error('至少需要一张图片');
  }

  const requestBody = {
    model: options.model || 'openai/gpt-image-2/edit',
    images: images,
    prompt: prompt,
    size: options.size || '1024x1024',
    quality: options.quality || 'medium',
    output_format: options.output_format || 'jpeg',
    enable_sync_mode: options.enable_sync_mode ?? true,
    enable_base64_output: options.enable_base64_output ?? false
  };

  const response = await fetch(`${IMAGE_API_BASE_URL}/model/editImage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${IMAGE_API_KEY}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`图片编辑 API 错误 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return {
    model: data.model,
    images: (data.data || []).map(img => ({
      url: img.url,
      b64Json: img.b64_json,
      revisedPrompt: img.revised_prompt
    }))
  };
}

module.exports = { chat, generateImage, editImage };
