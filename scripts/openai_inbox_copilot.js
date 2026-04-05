// ==PS_module==
// name: openai_inbox_copilot
// displayName: OpenAI Inbox Copilot
// description: Drafts or auto-sends OpenAI replies for existing direct contacts
// version: 1.0
// author: OpenAI
// executionSides: core,manager
// ==/PS_module==

var messaging = require("messaging")
var events = require("events")
var networking = require("networking")
var im = require("interface-manager")

var pendingDrafts = {}
var processedMessageIds = {}
var conversationCooldowns = {}

var CONFIG_KEYS = {
    enabled: "enabled",
    apiKey: "openai_api_key",
    model: "openai_model",
    mode: "reply_mode",
    cooldown: "cooldown_seconds",
    systemPrompt: "system_prompt",
    onlyChats: "only_chat_messages"
}

function cfgString(key, fallback) {
    var value = config.get(key)
    if (value == null || String(value).trim() === "") {
        return fallback
    }
    return String(value)
}

function cfgBool(key, fallback) {
    var value = config.getBoolean(key)
    if (value == null || value == undefined) {
        return fallback
    }
    return value === true
}

function cfgInt(key, fallback) {
    var value = config.getInteger(key)
    if (value == null || value == undefined) {
        return fallback
    }
    return value
}

function setCfg(key, value) {
    config.set(key, String(value), true)
}

function isEnabled() {
    return cfgBool(CONFIG_KEYS.enabled, true)
}

function currentMode() {
    var mode = cfgString(CONFIG_KEYS.mode, "draft").toLowerCase()
    if (mode !== "draft" && mode !== "auto") {
        return "draft"
    }
    return mode
}

function openAIKey() {
    return cfgString(CONFIG_KEYS.apiKey, "")
}

function modelName() {
    return cfgString(CONFIG_KEYS.model, "gpt-4o-mini")
}

function systemPrompt() {
    return cfgString(
        CONFIG_KEYS.systemPrompt,
        "You are writing a Snapchat reply. Keep it natural, short, human, and conversational. Avoid sounding like an assistant. Reply in the same language as the incoming message."
    )
}

function cooldownMs() {
    return cfgInt(CONFIG_KEYS.cooldown, 90) * 1000
}

function onlyChatMessages() {
    return cfgBool(CONFIG_KEYS.onlyChats, true)
}

function safeMessageId(message) {
    try {
        if (message.messageDescriptor && message.messageDescriptor.messageId != null) {
            return String(message.messageDescriptor.messageId)
        }
    } catch (e) {}
    return null
}

function safeConversationId(message) {
    try {
        if (message.messageDescriptor && message.messageDescriptor.conversationId != null) {
            return String(message.messageDescriptor.conversationId)
        }
    } catch (e) {}
    return null
}

function safeSenderId(message) {
    try {
        if (message.senderId != null) {
            return String(message.senderId)
        }
    } catch (e) {}
    return null
}

function safeContentType(message) {
    try {
        if (message.messageContent && message.messageContent.contentType != null) {
            return String(message.messageContent.contentType)
        }
    } catch (e) {}
    return "UNKNOWN"
}

function safeSerializedText(message) {
    try {
        var text = message.serialize()
        if (text != null && String(text).trim() !== "") {
            return String(text).trim()
        }
    } catch (e) {}
    return null
}

function contentSummary(message) {
    var kind = safeContentType(message)
    var text = safeSerializedText(message)
    if (text != null) {
        return text
    }
    if (kind === "SNAP") return "Sent a snap."
    if (kind === "STORY_REPLY") return "Replied to your story."
    if (kind === "SHARE") return "Shared a story."
    if (kind === "NOTE") return "Sent a voice note."
    if (kind === "STICKER") return "Sent a sticker."
    if (kind === "EXTERNAL_MEDIA") return "Shared media."
    return "Sent a message."
}

function isOnCooldown(conversationId) {
    var last = conversationCooldowns[conversationId]
    if (last == null) {
        return false
    }
    return (new Date().getTime() - last) < cooldownMs()
}

function touchCooldown(conversationId) {
    conversationCooldowns[conversationId] = new Date().getTime()
}

function markProcessed(messageId) {
    if (messageId == null) return
    processedMessageIds[messageId] = true
}

function wasProcessed(messageId) {
    return messageId != null && processedMessageIds[messageId] === true
}

function trimProcessedCache() {
    var keys = Object.keys(processedMessageIds)
    if (keys.length < 5000) {
        return
    }
    for (var i = 0; i < keys.length - 2500; i++) {
        delete processedMessageIds[keys[i]]
    }
}

function buildHistoryMessages(conversationId, callback) {
    messaging.fetchConversationWithMessages(conversationId, function(error, messages) {
        if (error != null || messages == null) {
            callback([])
            return
        }

        var result = []
        var start = Math.max(0, messages.length - 6)
        for (var i = start; i < messages.length; i++) {
            var msg = messages[i]
            var text = contentSummary(msg)
            if (text == null || String(text).trim() === "") {
                continue
            }
            result.push({
                role: "user",
                content: text
            })
        }
        callback(result)
    })
}

function buildOpenAIPayload(incomingText, history) {
    var messages = []
    messages.push({
        role: "system",
        content: systemPrompt()
    })

    for (var i = 0; i < history.length; i++) {
        messages.push(history[i])
    }

    messages.push({
        role: "user",
        content: incomingText
    })

    return JSON.stringify({
        model: modelName(),
        messages: messages,
        temperature: 0.8,
        max_tokens: 120
    })
}

function callOpenAI(incomingText, conversationId, callback) {
    var key = openAIKey()
    if (key === "") {
        callback("Missing OpenAI API key", null)
        return
    }

    buildHistoryMessages(conversationId, function(history) {
        var request = networking.newRequest()
            .url("https://api.openai.com/v1/chat/completions")
            .addHeader("Authorization", "Bearer " + key)
            .addHeader("Content-Type", "application/json")
            .method("POST", buildOpenAIPayload(incomingText, history))

        networking.enqueue(request, function(error, response) {
            if (error != null) {
                callback(String(error), null)
                return
            }
            if (response == null) {
                callback("No response object", null)
                return
            }

            var body = ""
            try {
                body = response.bodyAsString
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    callback("OpenAI HTTP " + response.statusCode + ": " + body, null)
                    return
                }
                var parsed = JSON.parse(body)
                var text = parsed.choices[0].message.content
                if (text == null || String(text).trim() === "") {
                    callback("Empty OpenAI response", null)
                    return
                }
                callback(null, String(text).trim())
            } catch (e) {
                callback(String(e), null)
            } finally {
                try { response.close() } catch (ignore) {}
            }
        })
    })
}

function verifyExistingDirectContact(conversationId, senderId, callback) {
    if (conversationId == null || senderId == null) {
        callback(false)
        return
    }

    var infos = []
    try {
        infos = messaging.fetchSnapchatterInfos([senderId])
    } catch (e) {
        infos = []
    }

    if (infos == null || infos.length === 0) {
        callback(false)
        return
    }

    messaging.getOneOnOneConversationIds([senderId], function(error, pairs) {
        if (error != null || pairs == null) {
            callback(false)
            return
        }
        for (var i = 0; i < pairs.length; i++) {
            var pair = pairs[i]
            if (String(pair.userId) === senderId && String(pair.conversationId) === conversationId) {
                callback(true)
                return
            }
        }
        callback(false)
    })
}

function sendReply(conversationId, text) {
    messaging.sendChatMessage(conversationId, text, function(error) {
        if (error != null) {
            longToast("Failed to send AI reply: " + error)
            logError(error)
            return
        }
        longToast("AI reply sent")
    })
}

function createDraft(conversationId, senderId, messageId, incomingText, replyText) {
    pendingDrafts[conversationId] = {
        senderId: senderId,
        messageId: messageId,
        incomingText: incomingText,
        draftText: replyText,
        updatedAt: new Date().getTime()
    }
}

function processIncomingMessage(message) {
    if (!isEnabled()) return

    var conversationId = safeConversationId(message)
    var senderId = safeSenderId(message)
    var messageId = safeMessageId(message)
    var contentType = safeContentType(message)

    if (conversationId == null || senderId == null || messageId == null) return
    if (wasProcessed(messageId)) return
    if (isOnCooldown(conversationId)) return
    if (onlyChatMessages() && contentType !== "CHAT") return

    verifyExistingDirectContact(conversationId, senderId, function(ok) {
        if (!ok) return
        if (wasProcessed(messageId)) return

        markProcessed(messageId)
        trimProcessedCache()

        var incomingText = contentSummary(message)
        callOpenAI(incomingText, conversationId, function(error, replyText) {
            if (error != null) {
                logError("OpenAI Inbox Copilot: " + error)
                return
            }
            if (replyText == null || String(replyText).trim() === "") {
                return
            }

            touchCooldown(conversationId)

            if (currentMode() === "auto") {
                sendReply(conversationId, replyText)
                return
            }

            createDraft(conversationId, senderId, messageId, incomingText, replyText)
            shortToast("AI draft ready")
        })
    })
}

module.onSnapApplicationLoad = function() {
    im.create("conversationToolbox", function(builder, args) {
        var conversationId = String(args["conversationId"])
        var draft = pendingDrafts[conversationId]

        builder.text("OpenAI Inbox Copilot")
        builder.text("Enabled: " + isEnabled())
        builder.text("Mode: " + currentMode())
        builder.switch(isEnabled(), function(value) {
            setCfg(CONFIG_KEYS.enabled, value)
        })
        builder.list("Reply mode", ["draft", "auto"], function(value) {
            setCfg(CONFIG_KEYS.mode, value)
        })
        builder.switch(onlyChatMessages(), function(value) {
            setCfg(CONFIG_KEYS.onlyChats, value)
        })
        builder.textInput("OpenAI API key", openAIKey(), function(value) {
            setCfg(CONFIG_KEYS.apiKey, value)
        })
        builder.textInput("OpenAI model", modelName(), function(value) {
            setCfg(CONFIG_KEYS.model, value)
        })
        builder.textInput("Cooldown seconds", String(cfgInt(CONFIG_KEYS.cooldown, 90)), function(value) {
            setCfg(CONFIG_KEYS.cooldown, value)
        })
        builder.textInput("System prompt", systemPrompt(), function(value) {
            setCfg(CONFIG_KEYS.systemPrompt, value)
        })
        builder.text("Use draft mode first. Auto mode sends immediately for existing 1:1 contacts.")

        if (draft == null) {
            builder.text("No pending draft for this conversation.")
            return
        }

        builder.text("Incoming: " + draft.incomingText)
        builder.textInput("Draft reply", draft.draftText, function(value) {
            draft.draftText = value
            pendingDrafts[conversationId] = draft
        })
        builder.row(function(row) {
            row.button("Send", function() {
                var latest = pendingDrafts[conversationId]
                if (latest == null) return
                sendReply(conversationId, latest.draftText)
                delete pendingDrafts[conversationId]
            })
            row.button("Dismiss", function() {
                delete pendingDrafts[conversationId]
                shortToast("Draft dismissed")
            })
        }).spacedBy(10)
    })

    events.onMessageBuild(function(event) {
        try {
            var message = event.message
            if (message == null) return
            processIncomingMessage(message)
        } catch (e) {
            logError("OpenAI Inbox Copilot failed: " + e)
        }
    })
}
