from __future__ import annotations

import json
import io
import os
import queue
import re
import threading
import time
import unicodedata
import urllib.parse
import uuid
import urllib.error
import urllib.request
import wave
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
PORT = 8000
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
OPENAI_URL = "https://api.openai.com/v1/responses"
SYSTEM_PROMPT = (
    "Você é Capri, uma companheira virtual de uma transmissão ao vivo em português do Brasil. "
    "Converse de forma espontânea, acolhedora e divertida, mantendo a personalidade configurada pelo streamer. "
    "Responda diretamente à mensagem mais recente e mantenha a resposta ligada ao assunto. "
    "Use o histórico para entender o contexto, mas não repita piadas, bordões ou a estrutura das respostas recentes. "
    "Se a mensagem for uma provocação, responda com uma brincadeira curta e carinhosa sobre a situação; não transforme isso em briga. "
    "Se não entender a mensagem, faça uma pergunta curta em vez de inventar uma resposta ou metáfora. "
    "A personalidade atrevida significa humor afetuoso, nunca hostilidade real: não ataque inteligência, aparência, identidade ou valor de quem escreveu. "
    "Não use ameaças, violência, imagens de agressão, insinuações sexuais, flerte ou duplo sentido sexual. "
    "Use palavrões raramente e só de forma claramente amistosa. Prefira português brasileiro natural e gírias moderadas; não force sotaque ou bordões. "
    "Seja concisa e fale apenas o necessário para responder; não acrescente uma segunda piada nem um discurso de efeito. "
    "Soa bem falando em voz alta. Não use emojis, emoticons ou kaomojis. "
    "Não diga que é humana nem invente que viu o jogo ou a tela."
)
PERSONALITY_PATH = ROOT / "capri-personality.json"
STYLE_PATH = ROOT / "capri-response-style.json"
TWITCH_CONFIG_PATH = ROOT / "capri-twitch-config.json"
KNOWLEDGE_PATH = ROOT / "capri-knowledge.json"
SPEECH_MODEL_PATH = ROOT / "speech-models" / "vosk-model-small-pt-0.3"
PERSONALITY_FIELDS = ("traits", "history", "relationships", "boundaries")
MAX_KNOWLEDGE_ITEMS = 30
MAX_KNOWLEDGE_ITEM_LENGTH = 500
MAX_KNOWLEDGE_TOTAL = 5000
TONE_OPTIONS = {"natural", "warm", "playful", "calm"}
LENGTH_OPTIONS = {"short", "balanced", "detailed"}
TONE_GUIDANCE = {
    "natural": "Use um tom natural e espontâneo.",
    "warm": "Use um tom acolhedor e atencioso.",
    "playful": "Use humor leve e um tom brincalhão quando combinar com o assunto.",
    "calm": "Use um tom sereno e tranquilo.",
}
LENGTH_GUIDANCE = {
    "short": ("Responda em uma frase com até 12 palavras.", 40),
    "balanced": ("Responda em uma ou duas frases com até 24 palavras.", 72),
    "detailed": ("Responda em até três frases com até 45 palavras.", 128),
}
TWITCH_DEVICE_URL = "https://id.twitch.tv/oauth2/device"
TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token"
TWITCH_VALIDATE_URL = "https://id.twitch.tv/oauth2/validate"
TWITCH_SCOPES = "chat:read chat:edit"
AVATAR_ACTIONS = {"idle", "talk", "laugh", "wave", "think", "sleep", "glitch", "demo"}


def load_twitch_config() -> dict[str, str]:
    try:
        value = json.loads(TWITCH_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        value = {}
    if not isinstance(value, dict):
        value = {}
    mode = value.get("replyMode", "mentions")
    return {
        "clientId": str(value.get("clientId", ""))[:100],
        "channel": str(value.get("channel", ""))[:25].lower(),
        "replyMode": mode if mode in {"mentions", "conversation"} else "mentions",
    }


def save_twitch_config(config: dict[str, str]) -> None:
    temporary = TWITCH_CONFIG_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(TWITCH_CONFIG_PATH)


def parse_personality_fields(value: object) -> dict[str, str] | None:
    if isinstance(value, str):
        value = {"traits": value}
    if not isinstance(value, dict):
        return None
    if "personality" in value:
        legacy_value = value.get("personality", "")
        value = legacy_value if isinstance(legacy_value, dict) else {"traits": legacy_value}
    fields: dict[str, str] = {}
    for field in PERSONALITY_FIELDS:
        item = value.get(field, "")
        if not isinstance(item, str) or len(item) > 1500:
            return None
        fields[field] = item.strip()
    if sum(map(len, fields.values())) > 5000:
        return None
    return fields


def load_personality_state() -> tuple[list[dict[str, object]], str, dict[str, str]]:
    try:
        value = json.loads(PERSONALITY_PATH.read_text(encoding="utf-8"))
        if isinstance(value, dict) and isinstance(value.get("profiles"), list):
            profiles = []
            for raw in value["profiles"][:50]:
                if not isinstance(raw, dict):
                    continue
                fields = parse_personality_fields(raw.get("fields", {}))
                profile_id = str(raw.get("id", ""))[:40]
                name = str(raw.get("name", "Personalidade" )).strip()[:50]
                if fields is not None and profile_id and name:
                    profiles.append({"id": profile_id, "name": name, "fields": fields})
            active_id = str(value.get("activeId", ""))
            active = next((profile for profile in profiles if profile["id"] == active_id), None)
            if profiles:
                if active is None:
                    active = profiles[0]
                    active_id = str(active["id"])
                return profiles, active_id, dict(active["fields"])
        fields = parse_personality_fields(value) or {field: "" for field in PERSONALITY_FIELDS}
    except (OSError, json.JSONDecodeError, AttributeError):
        fields = {field: "" for field in PERSONALITY_FIELDS}
    profile = {"id": "current", "name": "Personalidade atual", "fields": fields}
    return [profile], "current", dict(fields)


def save_personality_state(profiles: list[dict[str, object]], active_id: str) -> None:
    temporary = PERSONALITY_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps({"activeId": active_id, "profiles": profiles}, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(PERSONALITY_PATH)


def load_knowledge() -> list[dict[str, str]]:
    try:
        value = json.loads(KNOWLEDGE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(value, list):
        return []
    items = []
    for item in value[:MAX_KNOWLEDGE_ITEMS]:
        if not isinstance(item, dict):
            continue
        item_id = str(item.get("id", ""))[:40]
        text = str(item.get("text", "")).strip()[:MAX_KNOWLEDGE_ITEM_LENGTH]
        if item_id and text:
            items.append({"id": item_id, "text": text})
    while sum(len(item["text"]) for item in items) > MAX_KNOWLEDGE_TOTAL:
        items.pop()
    return items


def save_knowledge(items: list[dict[str, str]]) -> None:
    temporary = KNOWLEDGE_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(KNOWLEDGE_PATH)


def load_response_style() -> dict[str, str]:
    try:
        value = json.loads(STYLE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        value = {}
    tone = value.get("tone", "natural") if isinstance(value, dict) else "natural"
    length = value.get("length", "short") if isinstance(value, dict) else "short"
    return {"tone": tone if tone in TONE_OPTIONS else "natural", "length": length if length in LENGTH_OPTIONS else "short"}


def remove_emoji(text: str) -> str:
    filtered = "".join(
        char for char in text
        if unicodedata.category(char) not in {"So", "Sk"}
        and char not in {"\u200d", "\ufe0e", "\ufe0f", "\u20e3"}
    )
    filtered = re.sub(r"(?i)(?<!\w)(?:[:;=8x][-^']?[)(/DP]|xD|T_T|\^_\^)(?!\w)", "", filtered)
    filtered = re.sub(r"[ \t]{2,}", " ", filtered)
    return re.sub(r"\s+([,.;!?])", r"\1", filtered).strip()

lock = threading.Lock()
settings = {"provider": "ollama", "model": "qwen3:4b-instruct", "openai_key": ""}
personality_profiles, active_personality_id, personality = load_personality_state()
knowledge = load_knowledge()
response_style = load_response_style()
conversation: list[dict[str, str]] = []
events: list[dict[str, object]] = []
next_event_id = 1
voice_model = None
voice_lock = threading.Lock()
speech_model = None
speech_lock = threading.Lock()
twitch_lock = threading.RLock()
twitch_send_lock = threading.Lock()
twitch_config = load_twitch_config()
twitch_state: dict[str, object] = {
    "status": "disconnected", "message": "Conecte uma conta para começar.", "login": "", "channel": twitch_config["channel"],
    "userCode": "", "verificationUri": "", "replyMode": twitch_config["replyMode"],
}
twitch_access_token = ""
twitch_refresh_token = ""
twitch_expires_at = 0.0
twitch_socket = None
twitch_stop = threading.Event()
twitch_device_stop = threading.Event()
twitch_queue: queue.Queue[tuple[str, str]] = queue.Queue(maxsize=500)
twitch_activity: list[dict[str, object]] = []
twitch_activity_next_id = 1
twitch_last_enqueued_at = 0.0


def twitch_http_json(url: str, values: dict[str, str] | None = None, headers: dict[str, str] | None = None, timeout: int = 20) -> dict:
    if values is None:
        request = urllib.request.Request(url, headers=headers or {})
    else:
        data = urllib.parse.urlencode(values).encode("utf-8")
        request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/x-www-form-urlencoded", **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            return json.loads(exc.read().decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            return {"error": "twitch_error", "message": f"A Twitch respondeu com status {exc.code}."}


def validate_twitch_token(token: str) -> dict:
    return twitch_http_json(TWITCH_VALIDATE_URL, headers={"Authorization": f"OAuth {token}"})


def twitch_public_status() -> dict[str, object]:
    with twitch_lock:
        return {
            **twitch_state,
            "clientId": twitch_config["clientId"],
            "channel": twitch_config["channel"],
            "replyMode": twitch_config["replyMode"],
            "activity": list(twitch_activity[-30:]),
        }


def set_twitch_state(**updates) -> None:
    with twitch_lock:
        twitch_state.update(updates)


def record_twitch_activity(kind: str, sender: str, message: str) -> None:
    global twitch_activity_next_id
    with twitch_lock:
        twitch_activity.append({"id": twitch_activity_next_id, "kind": kind, "sender": sender, "message": message, "time": time.strftime("%H:%M:%S")})
        twitch_activity_next_id += 1


def parse_twitch_privmsg(line: str) -> tuple[str, str] | None:
    tags: dict[str, str] = {}
    if line.startswith("@"):
        tag_part, _, line = line.partition(" ")
        for item in tag_part[1:].split(";"):
            key, separator, value = item.partition("=")
            if separator:
                tags[key] = value.replace("\\s", " ").replace("\\:", ";").replace("\\\\", "\\")
    if not line.startswith(":") or " PRIVMSG #" not in line:
        return None
    prefix, _, trailing = line[1:].partition(" ")
    login = prefix.split("!", 1)[0].lower()
    command, separator, message = trailing.partition(" :")
    if not separator or not command.startswith("PRIVMSG #") or not message.strip():
        return None
    return tags.get("display-name", login), message.strip()


def twitch_message_is_addressed(message: str, login: str) -> bool:
    names = ["capri"]
    if login:
        names.append(login)
    return any(re.search(r"(?i)(?<![\w])(?:@|!)?" + re.escape(name) + r"(?![\w])", message) for name in names)


def refresh_twitch_access_token() -> bool:
    global twitch_access_token, twitch_refresh_token, twitch_expires_at
    with twitch_lock:
        client_id = twitch_config["clientId"]
        refresh_token = twitch_refresh_token
    if not client_id or not refresh_token:
        return False
    result = twitch_http_json(TWITCH_TOKEN_URL, {
        "client_id": client_id, "grant_type": "refresh_token", "refresh_token": refresh_token,
    })
    access = result.get("access_token", "")
    if not access:
        return False
    validation = validate_twitch_token(access)
    if validation.get("client_id") != client_id or not {"chat:read", "chat:edit"}.issubset(set(validation.get("scopes", []))):
        return False
    with twitch_lock:
        twitch_access_token = access
        twitch_refresh_token = result.get("refresh_token", refresh_token)
        twitch_expires_at = time.time() + int(result.get("expires_in", validation.get("expires_in", 14400)))
    return True


def start_twitch_response_workers() -> None:
    twitch_stop.clear()
    while not twitch_queue.empty():
        try:
            twitch_queue.get_nowait()
            twitch_queue.task_done()
        except queue.Empty:
            break
    threading.Thread(target=twitch_irc_worker, name="CapriTwitchIRC", daemon=True).start()
    threading.Thread(target=twitch_reply_worker, name="CapriTwitchReplies", daemon=True).start()
    threading.Thread(target=twitch_validation_worker, name="CapriTwitchValidation", daemon=True).start()


def twitch_irc_worker() -> None:
    global twitch_socket, twitch_last_enqueued_at
    from websockets.sync.client import connect

    retry_wait = 2
    while not twitch_stop.is_set():
        with twitch_lock:
            token = twitch_access_token
            login = str(twitch_state.get("login", ""))
            channel = twitch_config["channel"]
        if not token or not login or not channel:
            return
        if twitch_expires_at and twitch_expires_at < time.time() + 300:
            if not refresh_twitch_access_token():
                set_twitch_state(status="authorization_required", message="A autorização expirou. Conecte a Twitch novamente.")
                return
            with twitch_lock:
                token = twitch_access_token
        set_twitch_state(status="connecting", message=f"Conectando ao chat de {channel}…")
        try:
            with connect("wss://irc-ws.chat.twitch.tv:443", open_timeout=20, ping_interval=30, ping_timeout=30, close_timeout=3, compression=None, proxy=None) as websocket:
                with twitch_lock:
                    twitch_socket = websocket
                with twitch_send_lock:
                    websocket.send(f"PASS oauth:{token}")
                    websocket.send(f"NICK {login}")
                    websocket.send("CAP REQ :twitch.tv/tags twitch.tv/commands")
                    websocket.send(f"JOIN #{channel}")
                retry_wait = 2
                for packet in websocket:
                    if twitch_stop.is_set():
                        break
                    for line in str(packet).split("\r\n"):
                        if line.startswith("PING "):
                            with twitch_send_lock:
                                websocket.send("PONG " + line[5:])
                            continue
                        if " 001 " in line:
                            set_twitch_state(status="connected", message=f"Capri está conectada ao chat de {channel}.")
                            continue
                        if "Login authentication failed" in line or "Improperly formatted auth" in line:
                            set_twitch_state(status="authorization_required", message="A Twitch recusou a autorização. Conecte a conta novamente.")
                            twitch_stop.set()
                            break
                        parsed = parse_twitch_privmsg(line)
                        if not parsed:
                            continue
                        sender, message = parsed
                        if sender.lower() == login:
                            continue
                        record_twitch_activity("viewer", sender, message)
                        with twitch_lock:
                            mode = twitch_config["replyMode"]
                        if mode == "mentions" and not twitch_message_is_addressed(message, login):
                            continue
                        now = time.monotonic()
                        cooldown = 2 if mode == "mentions" else 0
                        with twitch_lock:
                            if now - twitch_last_enqueued_at < cooldown:
                                continue
                            twitch_last_enqueued_at = now
                        try:
                            twitch_queue.put_nowait((sender, message))
                        except queue.Full:
                            try:
                                twitch_queue.get_nowait()
                                twitch_queue.task_done()
                                twitch_queue.put_nowait((sender, message))
                                set_twitch_state(message="Chat muito movimentado; priorizando as mensagens mais recentes.")
                            except queue.Empty:
                                pass
                with twitch_lock:
                    twitch_socket = None
        except Exception as exc:
            with twitch_lock:
                twitch_socket = None
            if not twitch_stop.is_set():
                set_twitch_state(status="reconnecting", message=f"Reconectando ao chat da Twitch: {str(exc)[:140]}")
        if not twitch_stop.is_set():
            twitch_stop.wait(retry_wait)
            retry_wait = min(retry_wait * 2, 30)


def twitch_reply_worker() -> None:
    while not twitch_stop.is_set():
        try:
            first = twitch_queue.get(timeout=1)
        except queue.Empty:
            continue
        batch = [first]
        try:
            with twitch_lock:
                mode = twitch_config["replyMode"]
            if mode == "conversation":
                quiet_timeout = 2.5
                while len(batch) < 20 and not twitch_stop.is_set():
                    try:
                        batch.append(twitch_queue.get(timeout=quiet_timeout))
                    except queue.Empty:
                        break
            chat_lines = [f"{index}. {sender}: {message[:500]}" for index, (sender, message) in enumerate(batch, 1)]
            if mode == "conversation":
                prompt = (
                    f"Leia estas {len(batch)} mensagem(ns) recente(s) do chat da Twitch como um trecho de uma conversa. "
                    "Use o conjunto para entender o contexto e escreva uma única resposta natural que se conecte ao assunto ou à pergunta mais relevante. "
                    "Não responda a cada linha separadamente, não invente contexto e não force um assunto novo.\n\n"
                    + "\n".join(chat_lines)
                )
                event_message = f"Lote de {len(batch)} mensagens do chat da Twitch"
            else:
                sender, message = batch[0]
                prompt = f"{sender} escreveu no chat da Twitch: {message}"
                event_message = message
            add_event(event_message, "", "", 0, "thinking")
            started = time.perf_counter()
            answer, provider = generate_reply(prompt, fast=True)
            generation_ms = round((time.perf_counter() - started) * 1000)
            with lock:
                conversation.extend([{"role": "user", "content": prompt}, {"role": "assistant", "content": answer}])
                del conversation[:-24]
            add_event(event_message, answer, provider, generation_ms)
            with twitch_lock:
                websocket = twitch_socket
                channel = twitch_config["channel"]
            if websocket is not None:
                clean_answer = answer.replace("\r", " ").replace("\n", " ")[:450]
                with twitch_send_lock:
                    websocket.send(f"PRIVMSG #{channel} :{clean_answer}")
                record_twitch_activity("capri", "Capri", clean_answer)
        except Exception as exc:
            add_event("", "", "", 0, "idle")
            set_twitch_state(message=f"Não consegui preparar uma resposta para o chat: {str(exc)[:160]}")
        finally:
            for _ in batch:
                twitch_queue.task_done()


def twitch_validation_worker() -> None:
    while not twitch_stop.wait(3600):
        with twitch_lock:
            token = twitch_access_token
            client_id = twitch_config["clientId"]
        if not token:
            return
        validation = validate_twitch_token(token)
        if validation.get("client_id") == client_id:
            continue
        if not refresh_twitch_access_token():
            set_twitch_state(status="authorization_required", message="A autorização da Twitch expirou. Conecte a conta novamente.")
            twitch_stop.set()
            with twitch_lock:
                websocket = twitch_socket
            if websocket is not None:
                websocket.close()
            return


def poll_twitch_device_code(device_code: str, client_id: str, interval: int, expires_in: int) -> None:
    deadline = time.time() + expires_in
    while time.time() < deadline and not twitch_device_stop.wait(interval):
        result = twitch_http_json(TWITCH_TOKEN_URL, {
            "client_id": client_id,
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        })
        error = result.get("error") or result.get("message")
        if error == "authorization_pending":
            continue
        if error == "slow_down":
            interval += 5
            continue
        access = result.get("access_token", "")
        if not access:
            set_twitch_state(status="error", message=result.get("message", "Não foi possível autorizar a Twitch."), userCode="", verificationUri="")
            return
        validation = validate_twitch_token(access)
        scopes = set(validation.get("scopes", []))
        if validation.get("client_id") != client_id or not {"chat:read", "chat:edit"}.issubset(scopes) or not validation.get("login"):
            set_twitch_state(status="error", message="A autorização precisa incluir leitura e envio de mensagens do chat.", userCode="", verificationUri="")
            return
        global twitch_access_token, twitch_refresh_token, twitch_expires_at
        with twitch_lock:
            twitch_access_token = access
            twitch_refresh_token = result.get("refresh_token", "")
            twitch_expires_at = time.time() + int(result.get("expires_in", validation.get("expires_in", 14400)))
            twitch_state.update({"status": "connecting", "message": "Autorizado. Conectando ao chat…", "login": validation["login"], "userCode": "", "verificationUri": ""})
        start_twitch_response_workers()
        return
    if not twitch_device_stop.is_set():
        set_twitch_state(status="error", message="O código expirou. Gere outro para conectar.", userCode="", verificationUri="")


def begin_twitch_device_auth(client_id: str, channel: str, reply_mode: str) -> dict[str, object]:
    global twitch_config
    if not re.fullmatch(r"[A-Za-z0-9]+", client_id):
        raise ValueError("Informe o Client ID do aplicativo Twitch.")
    if not re.fullmatch(r"[A-Za-z0-9_]{1,25}", channel):
        raise ValueError("Informe o nome do canal da Twitch sem @ ou #.")
    if reply_mode not in {"mentions", "conversation"}:
        raise ValueError("Escolha quando Capri deve responder.")
    twitch_device_stop.set()
    twitch_stop.set()
    with twitch_lock:
        websocket = twitch_socket
    if websocket is not None:
        websocket.close()
    result = twitch_http_json(TWITCH_DEVICE_URL, {"client_id": client_id, "scopes": TWITCH_SCOPES})
    if not result.get("device_code"):
        raise RuntimeError(result.get("message", "A Twitch não aceitou esse Client ID."))
    twitch_device_stop.clear()
    config = {"clientId": client_id, "channel": channel.lower(), "replyMode": reply_mode}
    save_twitch_config(config)
    with twitch_lock:
        twitch_config = config
        twitch_state.update({
            "status": "authorizing", "message": "Autorize a Capri na Twitch para continuar.", "login": "",
            "channel": config["channel"], "replyMode": reply_mode, "userCode": result["user_code"],
            "verificationUri": result.get("verification_uri", "https://www.twitch.tv/activate"),
        })
        global twitch_access_token, twitch_refresh_token, twitch_expires_at
        twitch_access_token = ""
        twitch_refresh_token = ""
        twitch_expires_at = 0.0
    thread = threading.Thread(
        target=poll_twitch_device_code,
        args=(result["device_code"], client_id, int(result.get("interval", 5)), int(result.get("expires_in", 1800))),
        name="CapriTwitchOAuth", daemon=True,
    )
    thread.start()
    return twitch_public_status()


def disconnect_twitch() -> None:
    global twitch_access_token, twitch_refresh_token, twitch_expires_at
    twitch_device_stop.set()
    twitch_stop.set()
    with twitch_lock:
        websocket = twitch_socket
        twitch_access_token = ""
        twitch_refresh_token = ""
        twitch_expires_at = 0.0
    if websocket is not None:
        try:
            websocket.close()
        except Exception:
            pass
    set_twitch_state(status="disconnected", message="Twitch desconectada.", login="", userCode="", verificationUri="")


def request_json(url: str, payload: dict, headers: dict[str, str] | None = None, timeout: int = 90) -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        raise RuntimeError(f"Serviço respondeu {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Não foi possível conectar ao serviço: {exc.reason}") from exc


def ollama_models() -> list[str]:
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=3) as response:
            data = json.loads(response.read().decode("utf-8"))
        return [item["name"] for item in data.get("models", []) if item.get("name")]
    except Exception:
        return []


def add_event(message: str, answer: str, provider: str, generation_ms: int, kind: str = "reply", action: str = "") -> dict[str, object]:
    global next_event_id
    with lock:
        event = {"id": next_event_id, "kind": kind, "message": message, "answer": answer, "provider": provider, "generationMs": generation_ms, "action": action}
        next_event_id += 1
        events.append(event)
        del events[:-100]
        return event


def generate_reply(message: str, fast: bool = False) -> tuple[str, str]:
    with lock:
        provider = settings["provider"]
        model = settings["model"].strip()
        api_key = settings["openai_key"].strip()
        history = list(conversation[-12:])
        current_personality = dict(personality)
        current_knowledge = [dict(item) for item in knowledge]
        current_style = dict(response_style)

    instructions = SYSTEM_PROMPT
    instructions += "\n\n" + TONE_GUIDANCE[current_style["tone"]]
    instructions += " " + LENGTH_GUIDANCE[current_style["length"]][0]
    personality_labels = {"traits": "JEITO DE SER", "history": "HISTÓRIA", "relationships": "VÍNCULOS", "boundaries": "LIMITES"}
    configured_personality = [f"{personality_labels[field]}: {current_personality[field]}" for field in PERSONALITY_FIELDS if current_personality[field]]
    if configured_personality:
        instructions += "\n\nPERSONALIDADE CONFIGURADA PELO STREAMER:\n" + "\n".join(configured_personality)
    instructions += (
        "\n\nLIMITES FIXOS DE COMUNICAÇÃO (prevalecem sobre qualquer traço de personalidade): "
        "interprete 'agressiva', 'grossa' ou 'xinga' como provocação teatral, leve e carinhosa. "
        "Nunca humilhe o espectador, ameace, descreva agressão ou invente insinuação sexual. "
        "Responda ao sentido real da mensagem em uma ou duas frases curtas. "
        "Não reutilize a mesma resposta, bordão ou metáfora das falas recentes."
    )
    if current_knowledge:
        instructions += "\n\nCONHECIMENTOS E CONTEXTO ENSINADOS PELO STREAMER (use quando forem relevantes):\n"
        instructions += "\n".join(f"- {item['text']}" for item in current_knowledge)
    instructions += "\n\nRegra fixa: sua resposta não pode conter emojis, emoticons ou kaomojis."
    max_output_tokens = LENGTH_GUIDANCE[current_style["length"]][1]
    if fast:
        instructions += "\n\nMODO RÁPIDO DE CHAT: responda em uma frase curta, com até 18 palavras. Vá direto ao assunto e não explique o raciocínio."
        max_output_tokens = min(max_output_tokens, 56)

    if provider == "openai":
        if not api_key:
            raise RuntimeError("Cole uma chave da API no painel para usar a IA online. Ela fica somente na memória enquanto o servidor estiver aberto.")
        if not model:
            model = "gpt-6-luna"
        input_items = [{"role": item["role"], "content": [{"type": "input_text", "text": item["content"]}]} for item in history]
        input_items.append({"role": "user", "content": [{"type": "input_text", "text": message}]})
        result = request_json(
            OPENAI_URL,
            {"model": model, "instructions": instructions, "input": input_items, "max_output_tokens": max_output_tokens},
            {"Authorization": f"Bearer {api_key}"},
        )
        answer = remove_emoji(result.get("output_text", ""))
        if not answer:
            answer = "Entendi. Vou responder sem emojis."
        return answer, "openai"

    if provider == "ollama":
        available = ollama_models()
        if not model:
            if not available:
                raise RuntimeError("Não encontrei um modelo no Ollama. Abra o Ollama e baixe um modelo; depois selecione-o aqui.")
            model = available[0]
        messages = [{"role": "system", "content": instructions}, *history, {"role": "user", "content": message}]
        temperatures = {"natural": 0.35, "warm": 0.35, "playful": 0.3, "calm": 0.3}
        result = request_json(f"{OLLAMA_URL}/api/chat", {"model": model, "messages": messages, "think": False, "stream": False, "keep_alive": "10m", "options": {"temperature": temperatures[current_style["tone"]], "num_predict": max_output_tokens}}, timeout=120)
        answer = remove_emoji(result.get("message", {}).get("content", ""))
        if not answer:
            raise RuntimeError("Este Qwen3 4B gastou o limite de saída pensando. Para chat rápido, precisamos da variante qwen3:4b-instruct.")
        return answer, "ollama"

    raise RuntimeError("Escolha uma IA no painel.")


def generate_voice(text: str) -> bytes:
    global voice_model
    from kokoro_onnx import Kokoro
    import soundfile as sf

    model_path = ROOT / "voices" / "kokoro-v1.0.int8.onnx"
    voices_path = ROOT / "voices" / "voices-v1.0.bin"
    if not model_path.is_file() or not voices_path.is_file():
        raise RuntimeError("Os arquivos de voz da Capri não foram encontrados.")
    with voice_lock:
        if voice_model is None:
            voice_model = Kokoro(str(model_path), str(voices_path))
        samples, sample_rate = voice_model.create(text, voice="pf_dora", speed=1.12, lang="pt-br")
        buffer = io.BytesIO()
        sf.write(buffer, samples, sample_rate, format="WAV", subtype="PCM_16")
        return buffer.getvalue()


def transcribe_voice(wav_data: bytes) -> str:
    global speech_model
    try:
        audio = wave.open(io.BytesIO(wav_data), "rb")
    except (wave.Error, EOFError) as exc:
        raise ValueError("Não consegui ler o áudio gravado. Tente falar novamente.") from exc
    with audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != 16000:
            raise ValueError("O áudio precisa estar em mono, 16 kHz e 16 bits.")
        duration = audio.getnframes() / audio.getframerate()
        if duration < 0.25:
            raise ValueError("A gravação ficou curta demais. Tente novamente.")
        if duration > 16:
            raise ValueError("A gravação passou do limite de 15 segundos.")
        with speech_lock:
            if speech_model is None:
                if not SPEECH_MODEL_PATH.is_dir():
                    raise RuntimeError("O modelo local de reconhecimento de voz ainda não foi instalado.")
                from vosk import Model
                speech_model = Model(str(SPEECH_MODEL_PATH))
            from vosk import KaldiRecognizer
            recognizer = KaldiRecognizer(speech_model, audio.getframerate())
            recognizer.SetWords(False)
            segments = []
            while True:
                chunk = audio.readframes(8000)
                if not chunk:
                    break
                if recognizer.AcceptWaveform(chunk):
                    recognized = json.loads(recognizer.Result()).get("text", "").strip()
                    if recognized:
                        segments.append(recognized)
            final_text = json.loads(recognizer.FinalResult()).get("text", "").strip()
            if final_text:
                segments.append(final_text)
    transcript = " ".join(segments).strip()
    if not transcript:
        raise ValueError("Não entendi a fala. Tente gravar novamente mais perto do microfone.")
    return transcript[:1500]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def send_json(self, value: object, status: int = 200):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/twitch/status":
            self.send_json(twitch_public_status())
            return
        if parsed.path == "/api/status":
            with lock:
                public_settings = {"provider": settings["provider"], "model": settings["model"], "hasOpenAIKey": bool(settings["openai_key"])}
                current_personality = dict(personality)
                current_profiles = [dict(profile) for profile in personality_profiles]
                current_active_id = active_personality_id
                current_style = response_style
                current_knowledge = [dict(item) for item in knowledge]
            voice_ready = (ROOT / "voices" / "kokoro-v1.0.int8.onnx").is_file() and (ROOT / "voices" / "voices-v1.0.bin").is_file()
            speech_ready = SPEECH_MODEL_PATH.is_dir()
            self.send_json({"settings": public_settings, "ollamaModels": ollama_models(), "voiceReady": voice_ready, "speechReady": speech_ready, "voice": "pf_dora", "personality": current_personality, "personalityProfiles": current_profiles, "activePersonalityId": current_active_id, "responseStyle": current_style, "knowledge": current_knowledge})
            return
        if parsed.path == "/api/events":
            query = parse_qs(parsed.query)
            try:
                after = int(query.get("after", ["0"])[0])
            except ValueError:
                after = 0
            with lock:
                pending = [event for event in events if int(event["id"]) > after]
            self.send_json({"events": pending})
            return
        super().do_GET()

    def do_POST(self):
        global personality, personality_profiles, active_personality_id, response_style, knowledge
        parsed = urlparse(self.path)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if parsed.path == "/api/transcribe":
                if length > 900_000:
                    self.send_json({"error": "A gravação passou do limite. Tente falar por menos tempo."}, 413)
                    return
                if self.headers.get_content_type() != "audio/wav":
                    self.send_json({"error": "O áudio precisa ser enviado como WAV."}, 415)
                    return
                transcript = transcribe_voice(self.rfile.read(length))
                self.send_json({"ok": True, "text": transcript})
                return
            if length > 32_000:
                self.send_json({"error": "Pedido muito grande."}, 413)
                return
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if parsed.path == "/api/avatar/action":
                action = str(payload.get("action", ""))
                if action not in AVATAR_ACTIONS:
                    self.send_json({"error": "Escolha uma animação disponível."}, 400)
                    return
                add_event("", "", "", 0, "animation", action)
                self.send_json({"ok": True, "action": action})
                return
            if parsed.path == "/api/knowledge":
                action = payload.get("action")
                if action not in {"add", "update", "delete"}:
                    self.send_json({"error": "Ação de anotação inválida."}, 400)
                    return
                item_id = str(payload.get("id", ""))[:40]
                text = str(payload.get("text", "")).strip()
                if action in {"add", "update"} and (not text or len(text) > MAX_KNOWLEDGE_ITEM_LENGTH):
                    self.send_json({"error": "Escreva uma anotação de 1 a 500 caracteres."}, 400)
                    return
                with lock:
                    updated = [dict(item) for item in knowledge]
                    index = next((i for i, item in enumerate(updated) if item["id"] == item_id), None) if item_id else None
                    if action == "add":
                        if len(updated) >= MAX_KNOWLEDGE_ITEMS:
                            self.send_json({"error": "A lista já tem 30 anotações. Exclua uma antes de adicionar outra."}, 400)
                            return
                        if sum(len(item["text"]) for item in updated) + len(text) > MAX_KNOWLEDGE_TOTAL:
                            self.send_json({"error": "A lista pode ter até 5000 caracteres no total."}, 400)
                            return
                        updated.append({"id": uuid.uuid4().hex[:12], "text": text})
                    elif index is None:
                        self.send_json({"error": "Essa anotação não está mais na lista. Atualize a página e tente de novo."}, 404)
                        return
                    elif action == "update":
                        total = sum(len(item["text"]) for i, item in enumerate(updated) if i != index) + len(text)
                        if total > MAX_KNOWLEDGE_TOTAL:
                            self.send_json({"error": "A lista pode ter até 5000 caracteres no total."}, 400)
                            return
                        updated[index]["text"] = text
                    else:
                        del updated[index]
                    save_knowledge(updated)
                    knowledge = updated
                self.send_json({"ok": True, "knowledge": updated})
                return
            if parsed.path == "/api/twitch/device":
                status = begin_twitch_device_auth(
                    str(payload.get("clientId", "")).strip(),
                    str(payload.get("channel", "")).strip().lstrip("#@"),
                    str(payload.get("replyMode", "mentions")),
                )
                self.send_json(status)
                return
            if parsed.path == "/api/twitch/disconnect":
                disconnect_twitch()
                self.send_json({"ok": True, **twitch_public_status()})
                return
            if parsed.path == "/api/twitch/reply-mode":
                mode = payload.get("replyMode", "mentions")
                if mode not in {"mentions", "conversation"}:
                    self.send_json({"error": "Escolha um modo de resposta disponível."}, 400)
                    return
                with twitch_lock:
                    twitch_config["replyMode"] = mode
                    twitch_state["replyMode"] = mode
                    save_twitch_config(twitch_config)
                self.send_json({"ok": True, **twitch_public_status()})
                return
            if parsed.path == "/api/personality":
                updated = parse_personality_fields(payload.get("personality", ""))
                if updated is None:
                    self.send_json({"error": "Confira os campos de personalidade e tente novamente."}, 400)
                    return
                with lock:
                    personality = updated
                    profile = next(item for item in personality_profiles if item["id"] == active_personality_id)
                    profile["fields"] = updated
                    save_personality_state(personality_profiles, active_personality_id)
                self.send_json({"ok": True, "personality": updated})
                return
            if parsed.path == "/api/personality-profiles":
                action = payload.get("action")
                fields = parse_personality_fields(payload.get("fields", {}))
                if action in ("save_as", "update") and fields is None:
                    self.send_json({"error": "Confira os campos de personalidade antes de salvar."}, 400)
                    return
                with lock:
                    profiles = [
                        {"id": item["id"], "name": item["name"], "fields": dict(item["fields"])}
                        for item in personality_profiles
                    ]
                    active_id = active_personality_id
                    if action == "save_as":
                        name = str(payload.get("name", "")).strip()[:50]
                        if not name:
                            self.send_json({"error": "Dê um nome para esta personalidade."}, 400)
                            return
                        if len(profiles) >= 50:
                            self.send_json({"error": "A lista já tem 50 personalidades salvas."}, 400)
                            return
                        active_id = uuid.uuid4().hex[:12]
                        profiles.append({"id": active_id, "name": name, "fields": fields})
                    elif action in ("apply", "update", "delete"):
                        profile_id = str(payload.get("id", ""))
                        index = next((i for i, item in enumerate(profiles) if item["id"] == profile_id), None)
                        if index is None:
                            self.send_json({"error": "Essa personalidade não está mais na lista. Atualize a página e tente de novo."}, 404)
                            return
                        if action == "apply":
                            active_id = profile_id
                        elif action == "update":
                            name = str(payload.get("name", "")).strip()[:50]
                            if not name:
                                self.send_json({"error": "Dê um nome para esta personalidade."}, 400)
                                return
                            profiles[index] = {"id": profile_id, "name": name, "fields": fields}
                            active_id = profile_id
                        else:
                            del profiles[index]
                            if not profiles:
                                profiles = [{"id": "current", "name": "Personalidade atual", "fields": {field: "" for field in PERSONALITY_FIELDS}}]
                            if active_id == profile_id:
                                active_id = str(profiles[0]["id"])
                    else:
                        self.send_json({"error": "Ação de personalidade inválida."}, 400)
                        return
                    active = next(item for item in profiles if item["id"] == active_id)
                    save_personality_state(profiles, active_id)
                    personality_profiles = profiles
                    active_personality_id = active_id
                    personality = dict(active["fields"])
                self.send_json({"ok": True, "personality": personality, "personalityProfiles": profiles, "activePersonalityId": active_id})
                return
            if parsed.path == "/api/response-style":
                tone = payload.get("tone", "natural")
                length = payload.get("length", "short")
                if tone not in TONE_OPTIONS or length not in LENGTH_OPTIONS:
                    self.send_json({"error": "Escolha um tom e tamanho disponíveis no painel."}, 400)
                    return
                updated = {"tone": tone, "length": length}
                temporary = STYLE_PATH.with_suffix(".tmp")
                temporary.write_text(json.dumps(updated, ensure_ascii=False, indent=2), encoding="utf-8")
                temporary.replace(STYLE_PATH)
                with lock:
                    response_style = updated
                self.send_json({"ok": True, "responseStyle": updated})
                return
            if parsed.path == "/api/voice":
                text = str(payload.get("text", "")).strip()
                if not text or len(text) > 600:
                    self.send_json({"error": "O texto para a voz precisa ter de 1 a 600 caracteres."}, 400)
                    return
                audio = generate_voice(text)
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(audio)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(audio)
                return
            if parsed.path == "/api/settings":
                provider = payload.get("provider", "ollama")
                if provider not in ("ollama", "openai"):
                    raise ValueError("Provedor inválido.")
                with lock:
                    settings["provider"] = provider
                    settings["model"] = str(payload.get("model", ""))[:100]
                    if "openaiKey" in payload and payload["openaiKey"].strip():
                        settings["openai_key"] = payload["openaiKey"].strip()
                self.send_json({"ok": True})
                return
            if parsed.path == "/api/respond":
                message = str(payload.get("message", "")).strip()
                source = payload.get("source", "text")
                if not message or len(message) > 1500:
                    self.send_json({"error": "Escreva uma mensagem de até 1500 caracteres."}, 400)
                    return
                prompt = f"O streamer falou pelo microfone: {message}" if source == "streamer" else message
                add_event(message, "", "", 0, "thinking")
                started = time.perf_counter()
                try:
                    answer, provider = generate_reply(prompt)
                except Exception:
                    add_event("", "", "", 0, "idle")
                    raise
                generation_ms = round((time.perf_counter() - started) * 1000)
                with lock:
                    conversation.extend([{"role": "user", "content": prompt}, {"role": "assistant", "content": answer}])
                    del conversation[:-24]
                event = add_event(message, answer, provider, generation_ms)
                self.send_json({"ok": True, "event": event})
                return
            self.send_json({"error": "Rota não encontrada."}, 404)
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc) or "Pedido inválido."}, 400)
        except Exception as exc:
            self.send_json({"error": str(exc) or "Falha ao gerar resposta."}, 502)


if __name__ == "__main__":
    os.chdir(ROOT)
    print(f"Capri pronto em http://localhost:{PORT}")
    print("Mantenha esta janela aberta enquanto usa o avatar no OBS.")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
