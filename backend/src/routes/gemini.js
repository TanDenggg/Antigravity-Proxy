import { v4 as uuidv4 } from 'uuid';

import { verifyApiKey, recordApiKeyUsage } from '../middleware/auth.js';
import { accountPool } from '../services/accountPool.js';
import { acquireModelSlot, releaseModelSlot } from '../services/rateLimiter.js';
import { streamChat, chat } from '../services/antigravity.js';
import { createRequestLog } from '../db/index.js';
import { getMappedModel } from '../config.js';
import { logModelCall } from '../services/modelLogger.js';

function generateSessionId() {
    return String(-Math.floor(Math.random() * 9e18));
}

function unwrapAntigravityResponse(payload) {
    if (payload && typeof payload === 'object' && payload.response) {
        const merged = { ...payload.response };
        if (payload.traceId && !merged.traceId) merged.traceId = payload.traceId;
        return merged;
    }
    return payload;
}

function parseResetAfterMs(message) {
    if (!message) return null;
    const m = String(message).match(/reset after (\\d+)s/i);
    if (!m) return null;
    const seconds = Number.parseInt(m[1], 10);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return (seconds + 1) * 1000;
}

function sleep(ms) {
    if (!ms || ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
}

export default async function geminiRoutes(fastify) {
    // Gemini native endpoint (minimal): /v1beta/models/<model>:(generateContent|streamGenerateContent)
    // 目前主要用于 gemini-3-pro-image，透传 generationConfig.imageConfig 等字段到上游。
    fastify.post('/v1beta/models/*', {
        preHandler: verifyApiKey
    }, async (request, reply) => {
            const startTime = Date.now();
            const rest = typeof request.params?.['*'] === 'string' ? request.params['*'] : '';
            const decodedRest = decodeURIComponent(rest || '');
            const sep = decodedRest.lastIndexOf(':');
            if (sep <= 0) {
                return reply.code(404).send({
                    error: { message: `Not Found: POST /v1beta/models/${decodedRest}` }
                });
            }

            const modelFromPath = decodedRest.slice(0, sep);
            const action = decodedRest.slice(sep + 1);
            if (action !== 'generateContent' && action !== 'streamGenerateContent') {
                return reply.code(404).send({
                    error: { message: `Not Found: POST /v1beta/models/${decodedRest}` }
                });
            }

            const stream = action === 'streamGenerateContent';

            const requestedModel = modelFromPath.startsWith('models/')
                ? modelFromPath.slice('models/'.length)
                : modelFromPath;
            const model = getMappedModel(requestedModel);

            let account = null;
            let usage = null;
            let status = 'success';
            let errorMessage = null;
            let modelSlotAcquired = false;
            let invokedUpstream = false;
            let responseForLog = null;
            let streamChunksForLog = null;
            let errorResponseForLog = null;

            const maxRetries = Math.max(0, Number(process.env.UPSTREAM_CAPACITY_RETRIES || 2));
            const baseRetryDelayMs = Math.max(0, Number(process.env.UPSTREAM_CAPACITY_RETRY_DELAY_MS || 1000));
            const isCapacityError = (err) => {
                const msg = err?.message || '';
                return (
                    msg.includes('exhausted your capacity on this model') ||
                    msg.includes('Resource has been exhausted') ||
                    msg.includes('No capacity available') ||
                    err?.upstreamStatus === 429
                );
            };

            try {
                modelSlotAcquired = acquireModelSlot(model);
                if (!modelSlotAcquired) {
                    status = 'error';
                    errorMessage = 'Model concurrency limit reached';
                    errorResponseForLog = {
                        error: { message: 'Model concurrency limit reached, please retry later', code: 'model_concurrency_limit' }
                    };
                    return reply.code(429).send(errorResponseForLog);
                }

                const requestId = `agent-${uuidv4()}`;

                // Gemini 端点 body：允许 {request:{...}} 或直接 {...}
                const rawBody = request.body && typeof request.body === 'object' ? request.body : {};
                const innerRequest =
                    rawBody.request && typeof rawBody.request === 'object'
                        ? structuredClone(rawBody.request)
                        : structuredClone(rawBody);

                // 透传 generationConfig（包括 imageConfig），仅补最小默认值
                if (!innerRequest.generationConfig || typeof innerRequest.generationConfig !== 'object') {
                    innerRequest.generationConfig = {};
                }
                if (innerRequest.generationConfig.candidateCount === undefined) {
                    innerRequest.generationConfig.candidateCount = 1;
                }

                const requestType = model === 'gemini-3-pro-image' ? 'image_gen' : 'agent';

                const antigravityRequestBase = {
                    project: '',
                    requestId,
                    request: {
                        ...innerRequest,
                        sessionId: innerRequest.sessionId || generateSessionId()
                    },
                    model,
                    userAgent: 'antigravity',
                    requestType
                };

                if (stream) {
                    streamChunksForLog = [];
                    reply.raw.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive',
                        'X-Accel-Buffering': 'no'
                    });

                    const abortController = new AbortController();
                    request.raw.on('close', () => abortController.abort());

                    let lastUsage = null;
                    let sawAnyData = false;

                    try {
                        let attempt = 0;
                        while (true) {
                            attempt++;
                            account = await accountPool.getBestAccount(model);
                            const antigravityRequest = structuredClone(antigravityRequestBase);
                            antigravityRequest.project = account.project_id || '';

                            invokedUpstream = true;
                            try {
                                await streamChat(
                                    account,
                                    antigravityRequest,
                                    (data) => {
                                        sawAnyData = true;
                                        try {
                                            const parsed = JSON.parse(data);
                                            const unwrapped = unwrapAntigravityResponse(parsed);
                                            const usageMetadata = unwrapped?.usageMetadata;
                                            if (usageMetadata) {
                                                lastUsage = {
                                                    promptTokens: usageMetadata.promptTokenCount || 0,
                                                    completionTokens: usageMetadata.candidatesTokenCount || 0,
                                                    totalTokens: usageMetadata.totalTokenCount || 0,
                                                    thinkingTokens: usageMetadata.thoughtsTokenCount || 0
                                                };
                                            }
                                            streamChunksForLog.push(unwrapped);
                                            reply.raw.write(`data: ${JSON.stringify(unwrapped)}\n\n`);
                                        } catch {
                                            // 非 JSON chunk：忽略
                                        }
                                    },
                                    null,
                                    abortController.signal
                                );

                                accountPool.markCapacityRecovered(account.id, model);
                                break;
                            } catch (err) {
                                if (abortController.signal.aborted) return;
                                if (account && isCapacityError(err)) {
                                    accountPool.markCapacityLimited(account.id, model, err.message || '');
                                    accountPool.unlockAccount(account.id);
                                    account = null;
                                    if (attempt <= maxRetries + 1 && streamChunksForLog.length === 0) {
                                        const resetMs = parseResetAfterMs(err?.message);
                                        const delay = resetMs ?? (baseRetryDelayMs * attempt);
                                        await sleep(delay);
                                        continue;
                                    }
                                }
                                throw err;
                            }
                        }
                    } catch (err) {
                        status = 'error';
                        errorMessage = err.message;
                        const errorChunk = { error: { message: err.message, type: 'api_error' } };
                        errorResponseForLog = errorChunk;
                        reply.raw.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
                    }

                    if (status === 'success' && !sawAnyData) {
                        status = 'error';
                        errorMessage = 'Upstream returned empty response (no events)';
                        const errorChunk = { error: { message: errorMessage, type: 'api_error', code: 'empty_upstream_response' } };
                        errorResponseForLog = errorChunk;
                        reply.raw.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
                    }

                    reply.raw.end();

                    usage = lastUsage;
                    responseForLog = { stream: true, chunks: streamChunksForLog };
                    return;
                }

                // 非流式
                let antigravityResponse = null;
                let attempt = 0;
                while (true) {
                    attempt++;
                    account = await accountPool.getBestAccount(model);
                    const antigravityRequest = structuredClone(antigravityRequestBase);
                    antigravityRequest.project = account.project_id || '';

                    try {
                        invokedUpstream = true;
                        antigravityResponse = await chat(account, antigravityRequest);
                        accountPool.markCapacityRecovered(account.id, model);
                        break;
                    } catch (err) {
                        if (account && isCapacityError(err)) {
                            accountPool.markCapacityLimited(account.id, model, err.message || '');
                            accountPool.unlockAccount(account.id);
                            account = null;
                            if (attempt <= maxRetries + 1) {
                                const resetMs = parseResetAfterMs(err?.message);
                                const delay = resetMs ?? (baseRetryDelayMs * attempt);
                                await sleep(delay);
                                continue;
                            }
                        }
                        throw err;
                    }
                }

                const unwrapped = unwrapAntigravityResponse(antigravityResponse);
                const usageMetadata = unwrapped?.usageMetadata;
                usage = usageMetadata
                    ? {
                        promptTokens: usageMetadata.promptTokenCount || 0,
                        completionTokens: usageMetadata.candidatesTokenCount || 0,
                        totalTokens: usageMetadata.totalTokenCount || 0,
                        thinkingTokens: usageMetadata.thoughtsTokenCount || 0
                    }
                    : null;

                responseForLog = unwrapped;
                return reply.code(200).send(unwrapped);
            } catch (error) {
                status = 'error';
                errorMessage = error.message;

                const msg = error.message || '';
                const capacity = isCapacityError(error);

                if (account && capacity) {
                    accountPool.markCapacityLimited(account.id, model, msg);
                } else if (account) {
                    accountPool.markAccountError(account.id, error);
                }

                const httpStatus = capacity ? 429 : 500;
                const errorCode = capacity ? 'rate_limit_exceeded' : 'internal_error';
                errorResponseForLog = { error: { message: error.message, type: 'api_error', code: errorCode } };
                return reply.code(httpStatus).send(errorResponseForLog);
            } finally {
                if (modelSlotAcquired) releaseModelSlot(model);
                if (account) accountPool.unlockAccount(account.id);

                const latencyMs = Date.now() - startTime;
                createRequestLog({
                    accountId: account?.id,
                    apiKeyId: request.apiKey?.id,
                    model,
                    promptTokens: usage?.promptTokens || 0,
                    completionTokens: usage?.completionTokens || 0,
                    totalTokens: usage?.totalTokens || 0,
                    thinkingTokens: usage?.thinkingTokens || 0,
                    status,
                    latencyMs,
                    errorMessage
                });

                if (request.apiKey && usage?.totalTokens) {
                    recordApiKeyUsage(request.apiKey.id, usage.totalTokens);
                }

                try {
                    if (invokedUpstream) {
                        logModelCall({
                            kind: 'model_call',
                            provider: 'gemini',
                            endpoint: `/v1beta/models/${requestedModel}:${action}`,
                            model,
                            stream: !!stream,
                            status,
                            latencyMs,
                            account: account ? { id: account.id, email: account.email, tier: account.tier } : null,
                            request: request.body,
                            response: responseForLog,
                            errorResponse: errorResponseForLog
                        });
                    }
                } catch {
                    // ignore
                }
            }
    });
}
