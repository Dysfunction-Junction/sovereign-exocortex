package com.pieces.android.companion

import com.google.ai.edge.litertlm.*

/** The only production file permitted to reference LiteRT-LM. */
internal class LiteRtBridge(
    private val modelPath: java.util.function.Supplier<String>,
    private val cacheDir: String,
    private val maxNumTokens: Int,
    private val seed: Int
) : LlmBackend {
    private var engine: Engine? = null
    private val conversationLock = Any()
    private var conversation: Conversation? = null
    private var cancelled = false

    override fun init() {
        try {
            val cache = java.io.File(cacheDir)
            if (!cache.isDirectory && !cache.mkdirs()) throw LlmException(LlmException.Kind.FAILED)
            Engine.setNativeMinLogSeverity(LogSeverity.INFINITY)
            val e = Engine(EngineConfig(modelPath.get(), Backend.CPU(),
                maxNumTokens = maxNumTokens, cacheDir = cacheDir))
            e.initialize()
            engine = e
            synchronized(conversationLock) { cancelled = false }
        } catch (_: Exception) { throw LlmException(LlmException.Kind.FAILED) }
    }

    override fun generate(prompt: String, maxOutTokens: Int): String {
        val e = engine ?: throw LlmException(LlmException.Kind.NOT_INIT)
        try {
            val config = ConversationConfig(
                samplerConfig = SamplerConfig(1, 1.0, 0.0, seed),
                automaticToolCalling = false, maxOutputToken = maxOutTokens)
            e.createConversation(config).use { c ->
                try {
                    synchronized(conversationLock) {
                        conversation = c
                        if (cancelled) throw LlmException(LlmException.Kind.FAILED)
                    }
                    return c.sendMessage(prompt).toString()
                } finally {
                    synchronized(conversationLock) { conversation = null; cancelled = false }
                }
            }
        } catch (_: Exception) { throw LlmException(LlmException.Kind.FAILED) }
    }

    override fun cancelCurrent() {
        synchronized(conversationLock) {
            cancelled = true
            try { conversation?.cancelProcess() } catch (_: Exception) { }
        }
    }

    override fun close() {
        try { engine?.close() } finally { engine = null }
    }
}
