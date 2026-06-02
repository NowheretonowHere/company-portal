/**
 * 文档解析模块 — 从多种文件格式中提取纯文本
 * 支持: docx, pdf, xlsx/xls, pptx, txt, md, csv, json, html
 */

// 懒加载重型解析库，只在需要时 require
let _mammoth, _XLSX, _pdfParse, _AdmZip;

function mammoth() {
  if (!_mammoth) _mammoth = require('mammoth');
  return _mammoth;
}
function XLSX() {
  if (!_XLSX) _XLSX = require('xlsx');
  return _XLSX;
}
function pdfParse() {
  if (!_pdfParse) _pdfParse = require('pdf-parse');
  return _pdfParse;
}
function AdmZip() {
  if (!_AdmZip) _AdmZip = require('adm-zip');
  return _AdmZip;
}

// 纯文本类扩展名 — 可直接按 UTF-8 读取
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm',
  '.xml', '.yaml', '.yml', '.log', '.ini', '.cfg', '.conf',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.hpp',
  '.css', '.scss', '.less', '.sql', '.sh', '.bat', '.ps1', '.cmd',
  '.rst', '.tex', '.bib', '.toml', '.properties', '.env',
]);

// 所有支持的扩展名（用于错误提示）
const ALL_SUPPORTED = [
  '.docx', '.pdf', '.xlsx', '.xls', '.pptx',
  '.txt', '.md', '.csv', '.json', '.html', '.htm',
  '.xml', '.yaml', '.yml', '.log', '.ini', '.cfg', '.conf',
  '.js', '.ts', '.py', '.java', '.c', '.cpp', '.css', '.sql', '.sh', '.bat',
];

/**
 * 主入口 — 解析文档 buffer，返回 { title, content }
 * @param {Buffer} buffer 文件内容
 * @param {string} originalName 原始文件名
 * @returns {Promise<{title: string, content: string}>}
 */
async function parseDocument(buffer, originalName) {
  const path = require('path');
  const ext = path.extname(originalName).toLowerCase();
  const baseName = path.basename(originalName, ext);

  if (!buffer || buffer.length === 0) {
    throw new Error('文件为空，无法解析');
  }

  let content;

  if (TEXT_EXTENSIONS.has(ext)) {
    content = parseText(buffer, ext);
  } else {
    switch (ext) {
      case '.docx':
        content = await parseDocx(buffer);
        break;
      case '.pdf':
        content = await parsePdf(buffer);
        break;
      case '.xlsx':
      case '.xls':
        content = parseXlsx(buffer);
        break;
      case '.pptx':
        content = await parsePptx(buffer);
        break;
      default:
        throw new Error(
          `不支持的文件格式: ${ext || '未知'}。支持的格式: ${ALL_SUPPORTED.join(', ')}`
        );
    }
  }

  if (!content || !content.trim()) {
    throw new Error('文件中未提取到可读文本内容，请确认文件包含文字信息');
  }

  // 限制内容长度，防止超大文档撑爆数据库
  const MAX_LENGTH = 80000;
  if (content.length > MAX_LENGTH) {
    content = content.substring(0, MAX_LENGTH) + '\n\n... (原文过长，已截断至前80000字符)';
  }

  return {
    title: baseName.replace(/[_\-]+/g, ' ').trim() || '未命名文档',
    content: content.trim(),
  };
}

// ==================== 各格式解析器 ====================

/** 纯文本/代码文件: UTF-8 → 失败则 Latin-1 */
function parseText(buffer, ext) {
  let text = buffer.toString('utf-8');

  // 检测是否包含乱码替换字符，降级到 Latin-1
  if (text.includes('�')) {
    text = buffer.toString('latin1');
  }

  // HTML 类文件 strip 标签
  if (['.html', '.htm', '.xml'].includes(ext)) {
    text = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .trim();
  }

  return text;
}

/** .docx Word 文档 */
async function parseDocx(buffer) {
  const result = await mammoth().extractRawText({ buffer });
  if (result.messages && result.messages.length > 0) {
    console.warn('mammoth warnings:', result.messages);
  }
  return result.value || '';
}

/** .pdf 文档 */
async function parsePdf(buffer) {
  const data = await pdfParse()(buffer);
  return data.text || '';
}

/** .xlsx / .xls 表格 */
function parseXlsx(buffer) {
  const workbook = XLSX().read(buffer, { type: 'buffer' });
  const sheets = workbook.SheetNames;
  if (sheets.length === 0) return '';

  const parts = [];
  for (const name of sheets) {
    const sheet = workbook.Sheets[name];
    const csv = XLSX().utils.sheet_to_csv(sheet, { strip: true });
    // 单 sheet 时不用加标题
    if (sheets.length > 1) {
      parts.push(`=== ${name} ===\n${csv}`);
    } else {
      parts.push(csv);
    }
  }
  return parts.join('\n\n');
}

/** .pptx PowerPoint — 解压 ZIP 并从幻灯片 XML 中提取 <a:t> 文本 */
async function parsePptx(buffer) {
  const zip = new (AdmZip())(buffer);
  const entries = zip.getEntries();

  // 筛选并排序幻灯片文件
  const slideEntries = entries
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
    .sort((a, b) => {
      const na = parseInt((a.entryName.match(/slide(\d+)/i) || [])[1] || '0', 10);
      const nb = parseInt((b.entryName.match(/slide(\d+)/i) || [])[1] || '0', 10);
      return na - nb;
    });

  if (slideEntries.length === 0) {
    throw new Error('PPTX 文件中未找到幻灯片内容');
  }

  const parts = [];
  for (const entry of slideEntries) {
    const num = (entry.entryName.match(/slide(\d+)/i) || [])[1] || '?';
    const xml = entry.getData().toString('utf-8');
    const texts = [];
    const re = /<a:t[^>]*>([^<]*)<\/a:t>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const t = m[1].trim();
      if (t) texts.push(t);
    }
    if (texts.length > 0) {
      parts.push(`=== 幻灯片 ${num} ===\n${texts.join('\n')}`);
    }
  }

  return parts.join('\n\n') || '';
}

module.exports = { parseDocument };
