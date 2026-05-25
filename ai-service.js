const AI_SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT || '你是一个有帮助的AI助手。请用中文回答用户的问题。';

// ===== 聊天 API 供应商配置 =====
const chatProviders = {
  deepseek: {
    key: process.env.AI_API_KEY || '',
    baseUrl: process.env.AI_API_BASE_URL || 'https://api.deepseek.com/anthropic',
    defaultModel: process.env.AI_MODEL || 'deepseek-chat',
    format: 'anthropic'
  }
};

// ===== 图片生成 API 多供应商配置 =====
const imageProviders = {
  atlascloud: {
    key: process.env.IMAGE_API_KEY || '',
    baseUrl: process.env.IMAGE_API_BASE_URL || 'https://api.atlascloud.ai/api/v1',
    defaultModel: process.env.IMAGE_MODEL || 'openai/gpt-image-2/text-to-image',
    endpoint: '/model/generateImage'
  }
};

// 根据模型名匹配聊天供应商
function getChatProvider(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('deepseek')) return { ...chatProviders.deepseek, name: 'deepseek' };
  return { ...chatProviders.deepseek, name: 'deepseek' };
}

// 根据模型名匹配图片供应商
function getImageProvider(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('atlascloud') || m.includes('gpt-image')) return { ...imageProviders.atlascloud, name: 'atlascloud' };
  return { ...imageProviders.atlascloud, name: 'atlascloud' };
}

// 判断是否为图片编辑模型
function isEditModel(model) {
  return (model || '').toLowerCase().includes('edit');
}

/**
 * Chat completion — 多供应商自动路由。
 */
async function chat(messages, options = {}) {
  const model = options.model || chatProviders.deepseek.defaultModel;
  const provider = getChatProvider(model);

  if (!provider.key) {
    throw new Error(`AI_API_KEY 未配置 (${provider.name})，请联系管理员设置环境变量`);
  }

  if (provider.format === 'anthropic') {
    return chatAnthropic(provider, messages, model, options);
  }
  return chatOpenAI(provider, messages, model, options);
}

async function chatOpenAI(provider, messages, model, options) {
  const requestBody = {
    model,
    messages: [
      { role: 'system', content: AI_SYSTEM_PROMPT },
      ...messages
    ],
    temperature: options.temperature ?? 0.7,
    max_tokens: options.max_tokens ?? 2000
  };

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.key}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI API 错误 (${provider.name} ${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return {
    content: data.choices[0].message.content,
    model: data.model,
    usage: data.usage
  };
}

async function chatAnthropic(provider, messages, model, options) {
  const requestBody = {
    model,
    system: AI_SYSTEM_PROMPT,
    messages: messages,
    max_tokens: options.max_tokens ?? 2000,
    temperature: options.temperature ?? 0.7
  };

  const response = await fetch(`${provider.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI API 错误 (${provider.name} ${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return {
    content: data.content[0].text,
    model: data.model,
    usage: data.usage
  };
}

/**
 * Generate image (Text-to-Image) — 多供应商自动路由。
 * 根据模型名匹配图片生成供应商。
 */
async function generateImage(prompt, options = {}) {
  const model = options.model || imageProviders.atlascloud.defaultModel;
  const provider = getImageProvider(model);

  if (!provider.key) {
    throw new Error(`图片 API Key 未配置 (${provider.name})，请联系管理员设置环境变量`);
  }

  const requestBody = {
    model,
    prompt: prompt,
    n: options.n || 1,
    size: options.size || '1024x1024'
  };
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.key}`
  };

  const response = await fetch(`${provider.baseUrl}${provider.endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`图片生成 API 错误 (${provider.name} ${response.status}): ${errorText}`);
  }

  const data = await response.json();

  return {
    model: data.model || model,
    images: (data.data || []).map(img => ({
      url: img.url,
      b64Json: img.b64_json
    }))
  };
}

/**
 * Edit image — OpenAI 兼容格式。
 */
async function editImage(images, prompt, options = {}) {
  if (!images || images.length === 0) {
    throw new Error('至少需要一张图片');
  }

  const model = options.model || imageProviders.atlascloud.defaultModel;
  const provider = getImageProvider(model);

  if (!provider.key) {
    throw new Error(`图片 API Key 未配置 (${provider.name})，请联系管理员设置环境变量`);
  }

  const requestBody = {
    model,
    images: images,
    prompt: prompt,
    size: options.size || '1024x1024'
  };
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.key}`
  };
  const url = `${provider.baseUrl}/model/editImage`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`图片编辑 API 错误 (${provider.name} ${response.status}): ${errorText}`);
  }

  const data = await response.json();

  return {
    model: data.model,
    images: (data.data || []).map(img => ({
      url: img.url,
      b64Json: img.b64_json
    }))
  };
}

module.exports = { chat, generateImage, editImage, isEditModel };
