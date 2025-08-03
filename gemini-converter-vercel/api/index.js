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

// 新增：处理根路径 ("/") 的请求，返回 "Hello World"
app.get('/', (req, res) => {
    res.status(200).send('Hello World');
});

// 1. 处理模型列表请求 (/v1/models)
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

// 2. 处理聊天请求 (/v1/chat/completions)
app.post('/v1/chat/completions', async (req, res) => {
    console.log(`[处理] 收到 /v1/chat/completions 请求...`);
    const apiKey = getApiKey(req);
    if (!apiKey) {
        return res.status(401).json({ error: { message: 'Authorization header is missing or invalid.' } });
    }

    try {
        const openaiRequest = req.body;
        // 注意：Vercel 的无服务器环境不支持流式响应的直接转换，将以非流式返回
        if (openaiRequest.stream) {
            return res.status(400).json({ error: { message: 'Streaming is not supported in this Vercel deployment.' } });
        }

        const geminiRequest = openaiToGeminiRequest(openaiRequest);
        const model = openaiRequest.model || 'gemini-1.5-flash';
        const geminiUrl = `${GEMINI_API_ENDPOINT}/models/${model}:generateContent?key=${apiKey}`;

        const response = await axios.post(geminiUrl, geminiRequest, {
            headers: { 'Content-Type': 'application/json' }
        });

        const openaiResponse = geminiToOpenAIResponse(response.data, model);
        return res.status(200).json(openaiResponse);

    } catch (error) {
        console.error(`❌ 处理聊天请求失败: ${error.message}`);
        const status = error.response ? error.response.status : 500;
        const message = error.response ? error.response.data : 'An internal error occurred in the proxy.';
        return res.status(status).json({ error: { message, code: status } });
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

function geminiToOpenAIResponse(geminiResponse, model) {
    const content = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
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

// 导出 app 供 Vercel 使用
module.exports = app;
