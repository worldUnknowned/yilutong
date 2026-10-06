#!/usr/bin/env node
/**
 * 路路通译 · 轻量中转服务（零依赖，只需 Node 18+）
 *
 * 作用：把「小程序不能直连、也不能放密钥」的第三方免费翻译与语音服务，
 * 收敛成一个自己部署的、只暴露两个业务接口的小服务。
 * 密钥只存在于本机环境变量，小程序端只知道这一个中转地址。
 *
 * 启动：
 *   AZURE_TRANSLATOR_KEY=xxx AZURE_TRANSLATOR_REGION=eastasia \
 *   AZURE_SPEECH_KEY=xxx AZURE_SPEECH_REGION=eastasia \
 *   GOOGLE_API_KEY=xxx DEEPL_KEY=xxx-:fx \
 *   node relay-server.js
 *
 * 可选（Edge TTS 走本地命令行，完全免费、无需密钥）：
 *   pip install edge-tts
 *
 * 小程序端需要做两件事：
 *   1. 把本服务的域名加入小程序后台「开发 → 开发设置 → 服务器域名 → request 合法域名」
 *      （域名必须已 ICP 备案，且必须是 https）
 *   2. 在「我的 → 服务与加速」里填上本服务地址，点「保存并检测」
 *
 * 接口：
 *   GET  /health      -> { ok, providers: { translate: [...], tts: [...] } }
 *   POST /translate   -> { text }
 *   POST /tts         -> { audio: '<base64 mp3>' }
 *   所有失败都返回 { ok:false, code, message }，与小程序端 utils/relay.js 的约定一致。
 */

const http = require('http')
const https = require('https')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const PORT = Number(process.env.PORT || 8787)
const MAX_TEXT = 6000
const CACHE_LIMIT = 500
const UPSTREAM_TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT || 12000)

const ENV = process.env
const has = (name) => !!(ENV[name] && String(ENV[name]).trim())

/** 语种代码 -> 各服务商需要的区域码 */
const LOCALES = {
  zh: { google: 'zh-CN', azureTts: 'zh-CN', edge: 'zh-CN-XiaoxiaoNeural', deepgram: 'zh' },
  en: { google: 'en-US', azureTts: 'en-US', edge: 'en-US-JennyNeural' },
  ru: { google: 'ru-RU', azureTts: 'ru-RU', edge: 'ru-RU-SvetlanaNeural' },
  uz: { google: 'uz-UZ', azureTts: 'uz-UZ', edge: 'uz-UZ-MadinaNeural' },
  ko: { google: 'ko-KR', azureTts: 'ko-KR', edge: 'ko-KR-SunHiNeural' },
  ur: { google: 'ur-IN', azureTts: 'ur-PK', edge: 'ur-PK-UzmaNeural' },
  ar: { google: 'ar-XA', azureTts: 'ar-SA', edge: 'ar-SA-ZariyahNeural' },
  kk: { google: 'kk-KZ', azureTts: 'kk-KZ', edge: 'kk-KZ-AigulNeural' },
  fa: { google: 'fa-IR', azureTts: 'fa-IR', edge: 'fa-IR-DilaraNeural' },
  tr: { google: 'tr-TR', azureTts: 'tr-TR', edge: 'tr-TR-EmelNeural' },
  th: { google: 'th-TH', azureTts: 'th-TH', edge: 'th-TH-PremwadeeNeural' },
  vi: { google: 'vi-VN', azureTts: 'vi-VN', edge: 'vi-VN-HoaiMyNeural' },
  id: { google: 'id-ID', azureTts: 'id-ID', edge: 'id-ID-GadisNeural' },
}

/** DeepL 的目标语代码：与 ISO 不完全一致，且不支持中亚与南亚语种 */
const DEEPL_LANGS = { zh: 'ZH', en: 'EN-US', ru: 'RU', ko: 'KO', ar: 'AR', tr: 'TR', th: 'TH', vi: 'VI', id: 'ID' }

const memoryCache = new Map()

function cacheGet(key) {
  const hit = memoryCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > 6 * 60 * 60 * 1000) {
    memoryCache.delete(key)
    return null
  }
  return hit.value
}

function cacheSet(key, value) {
  if (memoryCache.size >= CACHE_LIMIT) {
    memoryCache.delete(memoryCache.keys().next().value)
  }
  memoryCache.set(key, { value, at: Date.now() })
}

/* ------------------------------ HTTP 小工具 ------------------------------ */

function request(options, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(options.url)
    const payload = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body)
    const req = https.request(
      {
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: options.method || (payload ? 'POST' : 'GET'),
        headers: Object.assign(
          payload ? { 'content-type': 'application/json' } : {},
          payload ? { 'content-length': Buffer.byteLength(payload) } : {},
          options.headers || {}
        ),
        timeout: options.timeout || UPSTREAM_TIMEOUT,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const buffer = Buffer.concat(chunks)
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(
              upstreamError(
                `${options.label || 'upstream'}_http_${res.statusCode}`,
                buffer.toString('utf8').slice(0, 300) || `上游返回 ${res.statusCode}`
              )
            )
            return
          }
          resolve({ status: res.statusCode, buffer, text: buffer.toString('utf8') })
        })
      }
    )
    req.on('timeout', () => req.destroy(upstreamError('upstream_timeout', '上游响应超时')))
    req.on('error', (error) =>
      reject(error.code ? error : upstreamError('upstream_network', error.message || '上游连接失败'))
    )
    if (payload) req.write(payload)
    req.end()
  })
}

function upstreamError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function readJson(response) {
  try {
    return JSON.parse(response.text)
  } catch (error) {
    throw upstreamError('upstream_bad_json', '上游返回的不是合法 JSON')
  }
}

/* ------------------------------- 翻译服务商 ------------------------------- */

const TRANSLATORS = {
  /** Azure AI Translator v3：语种覆盖最全（含乌兹别克语、哈萨克语、乌尔都语、波斯语） */
  azure: {
    available: () => has('AZURE_TRANSLATOR_KEY'),
    run: async ({ from, to, text }) => {
      const query = `api-version=3.0&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      const headers = {
        'Ocp-Apim-Subscription-Key': ENV.AZURE_TRANSLATOR_KEY,
        'content-type': 'application/json',
      }
      if (has('AZURE_TRANSLATOR_REGION')) {
        headers['Ocp-Apim-Subscription-Region'] = ENV.AZURE_TRANSLATOR_REGION
      }
      const res = await request(
        {
          url: `https://api.cognitive.microsofttranslator.com/translate?${query}`,
          method: 'POST',
          headers,
          label: 'azure',
        },
        [{ Text: text }]
      )
      const data = readJson(res)
      const first = Array.isArray(data) ? data[0] : null
      const value = first && first.translations && first.translations[0] && first.translations[0].text
      if (!value) throw upstreamError('azure_empty', 'Azure 没有返回译文')
      return value
    },
  },

  /** Google Cloud Translation v2（Google v2 兼容格式，Langbly 等同类服务可改 baseUrl 直接复用） */
  google: {
    available: () => has('GOOGLE_API_KEY'),
    run: async ({ from, to, text }) => {
      const res = await request(
        {
          url: `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(ENV.GOOGLE_API_KEY)}`,
          method: 'POST',
          label: 'google',
        },
        { q: text, source: from, target: to, format: 'text' }
      )
      const data = readJson(res)
      const value =
        data &&
        data.data &&
        data.data.translations &&
        data.data.translations[0] &&
        data.data.translations[0].translatedText
      if (!value) throw upstreamError('google_empty', 'Google 没有返回译文')
      return value
    },
  },

  /** DeepL：欧洲语种质量最好，但不支持中亚与南亚语种 */
  deepl: {
    available: () => has('DEEPL_KEY'),
    run: async ({ from, to, text }) => {
      if (!DEEPL_LANGS[to]) throw upstreamError('deepl_lang_unsupported', `DeepL 不支持目标语种 ${to}`)
      const host = String(ENV.DEEPL_KEY).endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com'
      const res = await request(
        {
          url: `https://${host}/v2/translate`,
          method: 'POST',
          headers: { authorization: `DeepL-Auth-Key ${ENV.DEEPL_KEY}` },
          label: 'deepl',
        },
        { text: [text], target_lang: DEEPL_LANGS[to] }
      )
      const data = readJson(res)
      const value = data && data.translations && data.translations[0] && data.translations[0].text
      if (!value) throw upstreamError('deepl_empty', 'DeepL 没有返回译文')
      return value
    },
  },

  /** MyMemory：完全免注册免密钥，适合当最后一道兜底（单次 500 字节上限、额度很小） */
  mymemory: {
    available: () => true,
    run: async ({ from, to, text }) => {
      const clipped = Buffer.from(text, 'utf8').slice(0, 480).toString('utf8')
      const query = `q=${encodeURIComponent(clipped)}&langpair=${encodeURIComponent(from + '|' + to)}`
      const suffix = has('MYMEMORY_EMAIL') ? `&de=${encodeURIComponent(ENV.MYMEMORY_EMAIL)}` : ''
      const res = await request({
        url: `https://api.mymemory.translated.net/get?${query}${suffix}`,
        label: 'mymemory',
      })
      const data = readJson(res)
      const value = data && data.responseData && data.responseData.translatedText
      if (!value) throw upstreamError('mymemory_empty', 'MyMemory 没有返回译文')
      return value
    },
  },

  /** 百度翻译开放平台：签名格式见官方文档，个人认证后额度 100 万字符/月 */
  baidu: {
    available: () => has('BAIDU_APP_ID') && has('BAIDU_APP_KEY'),
    run: async ({ from, to, text }) => {
      const appid = ENV.BAIDU_APP_ID
      const salt = String(Date.now())
      const sign = crypto
        .createHash('md5')
        .update(appid + text + salt + ENV.BAIDU_APP_KEY, 'utf8')
        .digest('hex')
      const query =
        `q=${encodeURIComponent(text)}&from=${encodeURIComponent(BAIDU_LANG[from] || from)}` +
        `&to=${encodeURIComponent(BAIDU_LANG[to] || to)}&appid=${appid}&salt=${salt}&sign=${sign}`
      const res = await request({ url: `https://fanyi-api.baidu.com/api/trans/vip/translate?${query}`, label: 'baidu' })
      const data = readJson(res)
      if (data.error_code) throw upstreamError('baidu_' + data.error_code, data.error_msg || '百度翻译返回错误')
      const value = data.trans_result && data.trans_result[0] && data.trans_result[0].dst
      if (!value) throw upstreamError('baidu_empty', '百度翻译没有返回译文')
      return value
    },
  },
}

/** 百度使用自己的语种代码 */
const BAIDU_LANG = { zh: 'zh', en: 'en', ru: 'ru', ko: 'kor', th: 'th', ar: 'ara', fa: 'per', vi: 'vie' }

/* ------------------------------- 语音服务商 ------------------------------- */

const SPEAKERS = {
  /** Azure AI Speech：13 个语种全部有神经音色，国内首包约 120ms */
  'azure-tts': {
    available: () => has('AZURE_SPEECH_KEY') && has('AZURE_SPEECH_REGION'),
    run: async ({ lang, text, voice }) => {
      const locale = (LOCALES[lang] && LOCALES[lang].azureTts) || 'en-US'
      const name = voice || (LOCALES[lang] && LOCALES[lang].edge) || 'en-US-JennyNeural'
      const ssml =
        `<speak version='1.0' xml:lang='${locale}'>` +
        `<voice name='${name}'>${escapeXml(text)}</voice></speak>`
      const res = await request(
        {
          url: `https://${ENV.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
          method: 'POST',
          headers: {
            'ocp-apim-subscription-key': ENV.AZURE_SPEECH_KEY,
            'content-type': 'application/ssml+xml',
            'x-microsoft-outputformat': 'audio-24khz-48kbitrate-mono-mp3',
          },
          label: 'azure-tts',
        },
        ssml
      )
      return res.buffer.toString('base64')
    },
  },

  /** Google Cloud TTS：月度免费额度最大，但不含乌兹别克语、哈萨克语、波斯语 */
  'google-tts': {
    available: () => has('GOOGLE_API_KEY'),
    run: async ({ lang, text }) => {
      const locale = (LOCALES[lang] && LOCALES[lang].google) || 'en-US'
      const res = await request(
        {
          url: `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(ENV.GOOGLE_API_KEY)}`,
          method: 'POST',
          label: 'google-tts',
        },
        {
          input: { text },
          voice: { languageCode: locale },
          audioConfig: { audioEncoding: 'MP3' },
        }
      )
      const data = readJson(res)
      if (!data.audioContent) throw upstreamError('google_tts_empty', 'Google TTS 没有返回音频')
      return data.audioContent
    },
  },

  /**
   * Edge TTS：走本地 edge-tts 命令行，免密钥、13 个语种全覆盖。
   * 它用的是 Edge 朗读的未公开接口，可能随时失效，所以只作为免费兜底。
   * 安装：pip install edge-tts
   */
  'edge-tts': {
    available: () => commandExists('edge-tts'),
    run: async ({ lang, text, voice }) => {
      const name = voice || (LOCALES[lang] && LOCALES[lang].edge) || 'en-US-JennyNeural'
      const out = path.join(os.tmpdir(), `lulu-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`)
      const result = spawnSync('edge-tts', ['--voice', name, '--text', text, '--write-media', out], {
        timeout: 20000,
      })
      if (result.status !== 0 || !fs.existsSync(out)) {
        throw upstreamError('edge_tts_failed', 'edge-tts 合成失败，请确认已 pip install edge-tts')
      }
      const base64 = fs.readFileSync(out).toString('base64')
      try {
        fs.unlinkSync(out)
      } catch (error) {
        /* 临时文件清理失败不影响结果 */
      }
      return base64
    },
  },
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function commandExists(name) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { timeout: 3000 })
  return probe.status === 0
}

/* --------------------------------- 服务 --------------------------------- */

const configuredTranslate = () => Object.keys(TRANSLATORS).filter((id) => TRANSLATORS[id].available())
const configuredTts = () => Object.keys(SPEAKERS).filter((id) => SPEAKERS[id].available())

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) {
        reject(upstreamError('request_too_large', '请求体过大（图片类内容请不要走后端翻译）'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(upstreamError('request_bad_json', '请求体不是合法 JSON'))
      }
    })
    req.on('error', (error) => reject(upstreamError('request_aborted', error.message)))
  })
}

function localize(code) {
  return String(code || '').trim().toLowerCase()
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (req.method === 'OPTIONS') {
    send(res, 204, {})
    return
  }

  if (url.pathname === '/health') {
    send(res, 200, {
      ok: true,
      providers: { translate: configuredTranslate(), tts: configuredTts() },
      cache: memoryCache.size,
    })
    return
  }

  try {
    const body = await readBody(req)

    if (url.pathname === '/translate' && req.method === 'POST') {
      const provider = String(body.provider || '')
      const handler = TRANSLATORS[provider]
      if (!handler || !handler.available()) {
        send(res, 400, { ok: false, code: 'provider_unavailable', message: `未配置服务商 ${provider}` })
        return
      }
      const from = localize(body.from)
      const to = localize(body.to)
      const text = String(body.text || '').trim()
      if (!text) {
        send(res, 400, { ok: false, code: 'empty_text', message: '缺少待翻译文本' })
        return
      }
      if (text.length > MAX_TEXT) {
        send(res, 400, { ok: false, code: 'text_too_long', message: `单次最多 ${MAX_TEXT} 字符` })
        return
      }
      const key = `t|${provider}|${from}|${to}|${crypto.createHash('sha1').update(text).digest('hex')}`
      const cached = cacheGet(key)
      if (cached) {
        send(res, 200, { ok: true, text: cached, provider, cached: true })
        return
      }
      const value = await handler.run({ from, to, text, glossary: body.glossary })
      cacheSet(key, value)
      send(res, 200, { ok: true, text: value, provider })
      return
    }

    if (url.pathname === '/tts' && req.method === 'POST') {
      const provider = String(body.provider || '')
      const handler = SPEAKERS[provider]
      if (!handler || !handler.available()) {
        send(res, 400, { ok: false, code: 'provider_unavailable', message: `未配置语音服务 ${provider}` })
        return
      }
      const lang = localize(body.lang)
      const text = String(body.text || '').trim().slice(0, 500)
      if (!text) {
        send(res, 400, { ok: false, code: 'empty_text', message: '缺少待合成文本' })
        return
      }
      const key = `s|${provider}|${lang}|${body.voice || ''}|${crypto.createHash('sha1').update(text).digest('hex')}`
      const cached = cacheGet(key)
      if (cached) {
        send(res, 200, { ok: true, audio: cached, mime: 'audio/mpeg', provider, cached: true })
        return
      }
      const audio = await handler.run({ lang, text, voice: body.voice, rate: body.rate })
      cacheSet(key, audio)
      send(res, 200, { ok: true, audio, mime: 'audio/mpeg', provider })
      return
    }

    send(res, 404, { ok: false, code: 'not_found', message: '未知接口，只有 /health、/translate、/tts' })
  } catch (error) {
    const code = (error && error.code) || 'relay_error'
    const message = (error && error.message) || '中转服务处理失败'
    console.error(`[relay] ${code}: ${message}`)
    send(res, 502, { ok: false, code, message })
  }
})

server.listen(PORT, () => {
  const t = configuredTranslate()
  const s = configuredTts()
  console.log(`路路通译中转服务已启动: http://127.0.0.1:${PORT}`)
  console.log(`  翻译通道: ${t.length ? t.join(', ') : '（无，请设置对应环境变量）'}`)
  console.log(`  语音通道: ${s.length ? s.join(', ') : '（无，可 pip install edge-tts 获取免费通道）'}`)
  console.log('')
  console.log('把这个地址填进小程序「我的 → 服务与加速」，并确保域名已备案且为 https。')
})
