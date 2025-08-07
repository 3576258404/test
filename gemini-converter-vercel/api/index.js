const express = require('express');
const axios = require('axios');
const cors = require('cors');

// --- Configuration ---
const GEMINI_API_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
const app = express();

// --- Middleware ---
app.use(cors()); // Enable CORS for cross-origin access
app.use(express.json({ limit: '50mb' }));

// --- Routes ---

// Handle root path ("/") requests
app.get('/', (req, res) => {
    res.status(200).send('Hello World');
});

// Handle /v1 path requests with a status message
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

// Handle model list requests (/v1/models)
app.get('/v1/models', async (req, res) => {
    console.log(`[Handling] Received /v1/models request...`);
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
        
        console.log(`✅ Successfully fetched and returned ${openaiModels.length} models.`);
        return res.status(200).json({ "object": "list", "data": openaiModels });

    } catch (error) {
        console.error(`❌ Failed to fetch models: ${error.message}`);
        const status = error.response ? error.response.status : 500;
        const message = error.response ? error.response.data : 'Failed to fetch models from Google Gemini API.';
        return res.status(status).json({ error: { message, code: status } });
    }
});

// Handle chat completion requests (/v1/chat/completions)
app.post('/v1/chat/completions', async (req, res) => {
    console.log(`[Handling] Received /v1/chat/completions request...`);
    const apiKey = getApiKey(req);
    if (!apiKey) {
        return res.status(401).json({ error: { message: 'Authorization header is missing or invalid.' } });
    }

    try {
        const openaiRequest = req.body;
        const geminiRequest = openaiToGeminiRequest(openaiRequest);
        const model = openaiRequest.model || 'gemini-1.5-flash';

        // --- Core Modification: Handle Streaming vs. Non-Streaming ---
        if (openaiRequest.stream) {
            const streamSuffix = ':streamGenerateContent';
            const geminiUrl = `${GEMINI_API_ENDPOINT}/models/${model}${streamSuffix}?key=${apiKey}`;
            
            const response = await axios.post(geminiUrl, geminiRequest, {
                responseType: 'stream'
            });

            // Set headers for Server-Sent Events (SSE)
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            });
            
            // Transform and pipe the stream
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
        console.error(`❌ Failed to handle chat request: ${error.message}`);
        // Ensure stream is ended on error if headers were sent
        if (res.writable && !res.headersSent) {
            const status = error.response ? error.response.status : 500;
            const message = error.response ? error.response.data : 'An internal error occurred in the proxy.';
            return res.status(status).json({ error: { message, code: status } });
        } else if (res.writable) {
            res.end();
        }
    }
});

// --- Helper Functions ---

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

/**
 * Transforms a Gemini SSE stream to an OpenAI SSE stream and writes it to the response.
 * @param {Stream} geminiStream - The incoming stream from the Gemini API.
 * @param {ServerResponse} res - The Express response object.
 * @param {string} model - The model name used.
 */
function transformGeminiStreamToOpenAIStream(geminiStream, res, model) {
    let buffer = '';
    const id = `chatcmpl-${Buffer.from(Math.random().toString()).toString('hex').substring(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

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
                // Ignore parsing errors which can happen with incomplete chunks
            }
            boundary = buffer.indexOf('\n\n');
        }
    });

    geminiStream.on('end', () => {
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

// Export the app for Vercel
module.exports = app;
