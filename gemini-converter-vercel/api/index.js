const express = require('express');
const axios = require('axios');
const cors = require('cors');

// --- 配置 ---
const GEMINI_API_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
const app = express();

// --- 中间件 ---
app.use(cors()); // 启用 CORS，允许跨域访问
app.use(express.json({ limit: '50mb' }));

// --- 路由 ---

// 处理根路径 ("/") 的请求
app.get('/', (req, res) => {
    res.status(200).send('Hello World');
});

// 处理 /v1 路径的请求，返回状态信息
app.get('/v1', (req, res) => {
    res.status(200).json({
        status: 'active',
        message: 'Gemini to OpenAI proxy is running.',
        endpoints: [
            '/v1/models',
            '/v1/chat/completions'
        ]
    });
});

// 处理模型列表请求 (/v1/models)
app.get('/v1/models', async (req, res) => {
    console.log(`[处理] 收到 /v1/models 请求...`);
    const apiKey = getApiKey(req);
    if (!apiKey) {
        return res.status(401).json({ error: { message: 'Authorization header is missing or invalid.' } });
    }

    try {
        const geminiUrl = `${GEMINI_API_ENDPOINT}/models?key=${apiKey}`;
        const response = await axios.get(geminiUrl);
        
        const openaiModels = response.data.models
            .filter(model => model.supportedGenerationMethods.includes("generateContent"))
            .map(model => ({
                id: model.name.replace('models/', ''),
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "google"
            }));
        
        console.log(`✅ 成功获取并返回了 ${openaiModels.length} 个模型。`);
        return res.status(200).json({ "object": "list", "data": openaiModels });

    } catch (error) {
        console.error(`❌ 获取模型列表失败: ${error.message}`);
        const status = error.response ? error.response.status : 500;
        const message = error.response ? error.response.data : 'Failed to fetch models from Google Gemini API.';
        return res.status(status).json({ error: { message, code: status } });
    }
});

// 处理聊天请求 (/v1/chat/completions)
app.post('/v1/chat/completions', async (req, res) => {
    console.log(`[处理] 收到 /v1/chat/completions 请求...`);
    const apiKey = getApiKey(req);
    if (!apiKey) {
        return res.status(401).json({ error: { message: 'Authorization header is missing or invalid.' } });
    }

    try {
        const openaiRequest = req.body;
        const geminiRequest = openaiToGeminiRequest(openaiRequest);
        const model = openaiRequest.model || 'gemini-1.5-flash';

        if (openaiRequest.stream) {
            const streamSuffix = ':streamGenerateContent';
            const geminiUrl = `${GEMINI_API_ENDPOINT}/models/${model}${streamSuffix}?key=${apiKey}`;
            
            const response = await axios.post(geminiUrl, geminiRequest, {
                responseType: 'stream'
            });

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            });
            
            transformGeminiStreamToOpenAIStream(response.data, res, model);

        } else {
            const streamSuffix = ':generateContent';
            const geminiUrl = `${GEMINI_API_ENDPOINT}/models/${model}${streamSuffix}?key=${apiKey}`;

            const response = await axios.post(geminiUrl, geminiRequest, {
                headers: { 'Content-Type': 'application/json' }
            });

            const openaiResponse = geminiToOpenAIResponse(response.data, model);
            return res.status(200).json(openaiResponse);
        }

    } catch (error) {
        console.error(`❌ 处理聊天请求失败: ${error.message}`);
        if (res.writable && !res.headersSent) {
            const status = error.response ? error.response.status : 500;
            const message = error.response ? error.response.data : 'An internal error occurred in the proxy.';
            return res.status(status).json({ error: { message, code: status } });
        } else if (res.writable) {
            res.end();
        }
    }
});

// --- 辅助函数 ---

function getApiKey(request) {
    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    return authHeader.substring(7);
}

function openaiToGeminiRequest(openaiRequest) {
    const geminiRequest = {
        contents: [],
        generationConfig: {},
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
    };

    if (openaiRequest.max_tokens) geminiRequest.generationConfig.maxOutputTokens = openaiRequest.max_tokens;
    if (openaiRequest.temperature) geminiRequest.generationConfig.temperature = openaiRequest.temperature;
    
    for (const message of openaiRequest.messages) {
        const role = message.role === 'assistant' ? 'model' : 'user';
        geminiRequest.contents.push({ role: role, parts: [{ text: message.content }] });
    }
    return geminiRequest;
}

/**
 * 将 Gemini 的完整响应转换为 OpenAI 格式，并处理空内容
 * @param {object} geminiResponse 
 * @param {string} model 
 * @returns {object}
 */
function geminiToOpenAIResponse(geminiResponse, model) {
    // --- 核心修改：检查内容是否为空 ---
    let content = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!content.trim()) {
        content = '喵~'; // 如果内容为空或只包含空白，则替换
    }

    return {
        id: `chatcmpl-${Buffer.from(Math.random().toString()).toString('hex').substring(0, 12)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            message: { role: 'assistant', content: content },
            finish_reason: 'stop',
        }],
        usage: {
            prompt_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
            completion_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
            total_tokens: geminiResponse.usageMetadata?.totalTokenCount || 0,
        },
    };
}

/**
 * 将 Gemini 的流式响应转换为 OpenAI 格式，并处理空内容
 * @param {Stream} geminiStream 
 * @param {ServerResponse} res 
 * @param {string} model 
 */
function transformGeminiStreamToOpenAIStream(geminiStream, res, model) {
    let buffer = '';
    const id = `chatcmpl-${Buffer.from(Math.random().toString()).toString('hex').substring(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);
    let hasSentContent = false; // 标记是否已发送过任何有效内容

    geminiStream.on('data', chunk => {
        buffer += chunk.toString();
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
            const jsonString = buffer.substring(0, boundary).replace(/^data: /, '');
            buffer = buffer.substring(boundary + 2);
            try {
                const geminiChunk = JSON.parse(jsonString);
                const content = geminiChunk.candidates?.[0]?.content?.parts?.[0]?.text || '';
                if (content) {
                    hasSentContent = true; // 标记已发送有效内容
                    const openaiChunk = {
                        id: id,
                        object: 'chat.completion.chunk',
                        created: created,
                        model: model,
                        choices: [{ index: 0, delta: { content: content }, finish_reason: null }],
                    };
                    res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
                }
            } catch (e) {
                // 忽略可能因数据块不完整导致的解析错误
            }
            boundary = buffer.indexOf('\n\n');
        }
    });

    geminiStream.on('end', () => {
        // --- 核心修改：在流结束时检查是否发送过内容 ---
        if (!hasSentContent) {
            // 如果整个流都没有发送任何内容，则发送 "喵~"
            const meowChunk = {
                id: id,
                object: 'chat.completion.chunk',
                created: created,
                model: model,
                choices: [{ index: 0, delta: { content: '喵~' }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(meowChunk)}\n\n`);
        }

        const doneChunk = {
            id: id,
            object: 'chat.completion.chunk',
            created: created,
            model: model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write(`data: [DONE]\n\n`);
        res.end();
    });

    geminiStream.on('error', (err) => {
        console.error("Stream error:", err);
        if (!res.writableEnded) {
            res.end();
        }
    });
}

// 导出 app 供 Vercel 或其他 Node.js 环境使用
module.exports = app;
