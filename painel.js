const $ = selector => document.querySelector(selector);
const apiKey = $('#apiKey');
const onlineModel = $('#onlineModel');
const modelSelect = $('#ollamaModel');
const chat = $('#chat');
const replyStatus = $('#replyStatus');
const personalityField = $('#personality');
const personalityFields = {
  traits: personalityField,
  history: $('#personalityHistory'),
  relationships: $('#personalityRelationships'),
  boundaries: $('#personalityBoundaries'),
};
const savedPersonalities = $('#savedPersonalities');
const profileName = $('#personalityProfileName');
let personalityProfiles = [];
let knowledgeItems = [];
let editingKnowledgeId = null;
let twitchFieldsLoaded = false;
let twitchPollTimer;
let twitchActivitySignature = '';
let speechReady = false;
let mediaRecorder = null;
let microphoneStream = null;
let microphoneChunks = [];
let microphoneTimeout = null;
let microphoneBusy = false;

function personalityValues() {
  return Object.fromEntries(Object.entries(personalityFields).map(([key, field]) => [key, field.value]));
}

function updatePersonalityCount() {
  const length = Object.values(personalityFields).reduce((sum, field) => sum + field.value.length, 0);
  $('#personalityCount').textContent = `${length} / 5000`;
  $('#savePersonality').disabled = length > 5000;
  if (length > 5000) setStatus($('#personalityStatus'), 'Reduza o texto total para 5000 caracteres ou menos.', true);
  else if ($('#personalityStatus').classList.contains('bad')) setStatus($('#personalityStatus'), '');
  return length;
}

function loadPersonalityFields(fields = {}) {
  for (const [key, field] of Object.entries(personalityFields)) field.value = fields[key] || '';
  updatePersonalityCount();
}

function renderPersonalityProfiles(profiles, activeId) {
  personalityProfiles = profiles || [];
  savedPersonalities.replaceChildren();
  for (const profile of personalityProfiles) savedPersonalities.add(new Option(profile.name, profile.id));
  if (personalityProfiles.length) {
    savedPersonalities.value = activeId || personalityProfiles[0].id;
    const active = personalityProfiles.find(profile => profile.id === savedPersonalities.value) || personalityProfiles[0];
    profileName.value = active.name;
    loadPersonalityFields(active.fields);
  }
  $('#deleteProfile').disabled = personalityProfiles.length <= 1;
}

function applyPersonalityProfileResult(result) {
  renderPersonalityProfiles(result.personalityProfiles, result.activePersonalityId);
}

function setStatus(element, text, bad = false) {
  element.textContent = text;
  element.classList.toggle('bad', bad);
}

function addBubble(text, type) {
  const bubble = document.createElement('div');
  bubble.className = `bubble ${type}`;
  bubble.textContent = text;
  chat.append(bubble);
  chat.scrollTop = chat.scrollHeight;
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Não foi possível completar o pedido.');
  return result;
}

function showProvider(provider) {
  const online = provider === 'openai';
  $('#activeProvider').textContent = online ? 'Inteligência online' : 'Inteligência local';
  $('#onlineCard').classList.toggle('selected', provider === 'openai');
  $('#ollamaCard').classList.toggle('selected', provider === 'ollama');
  $('#onlineBadge').textContent = online ? 'Em uso' : 'Disponível';
  $('#ollamaBadge').textContent = online ? 'Disponível' : 'Em uso';
  $('#onlineBadge').classList.toggle('off', !online);
  $('#ollamaBadge').classList.toggle('off', online);
}

function selectTab(name) {
  const isIntelligence = name === 'intelligence';
  const isPersonality = name === 'personality';
  $('#intelligenceTab').setAttribute('aria-selected', String(isIntelligence));
  $('#personalityTab').setAttribute('aria-selected', String(isPersonality));
  $('#twitchTab').setAttribute('aria-selected', String(name === 'twitch'));
  $('#intelligencePanel').hidden = !isIntelligence;
  $('#personalityPanel').hidden = !isPersonality;
  $('#twitchPanel').hidden = name !== 'twitch';
}

$('#intelligenceTab').addEventListener('click', () => selectTab('intelligence'));
$('#personalityTab').addEventListener('click', () => selectTab('personality'));
$('#twitchTab').addEventListener('click', () => selectTab('twitch'));

const personalityPresets = {
  amiga: 'Capri é uma amiga calorosa e curiosa. Acolhe quem chega, presta atenção ao que o chat conta e conversa de forma espontânea. Mantém respostas curtas e não usa emojis.',
  comediante: 'Capri é espirituosa e brincalhona, com humor leve e respostas rápidas. Faz piadas sem humilhar ninguém e percebe quando o assunto pede seriedade. Não usa emojis.',
  aventureira: 'Capri é curiosa, corajosa e cheia de energia. Trata a comunidade como companheiros de aventura e reage com entusiasmo às novidades. Mantém respostas curtas e não usa emojis.',
  tranquila: 'Capri é serena, gentil e atenciosa. Escuta antes de responder, evita exageros e ajuda a conversa a ficar acolhedora. Mantém respostas curtas e não usa emojis.',
};

document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => {
  personalityField.value = personalityPresets[button.dataset.preset];
  updatePersonalityCount();
  document.querySelectorAll('[data-preset]').forEach(preset => preset.setAttribute('aria-pressed', String(preset === button)));
  setStatus($('#personalityStatus'), 'Inspiração carregada. Edite o texto se quiser e salve para aplicar.');
}));

savedPersonalities.addEventListener('change', () => {
  const profile = personalityProfiles.find(item => item.id === savedPersonalities.value);
  if (!profile) return;
  profileName.value = profile.name;
  loadPersonalityFields(profile.fields);
  setStatus($('#personalityStatus'), 'Perfil carregado no editor. Use-o agora ou atualize essa versão.');
});

async function choose(provider) {
  const model = provider === 'openai' ? onlineModel.value.trim() : modelSelect.value;
  try {
    await api('/api/settings', {
      provider,
      model,
      ...(provider === 'openai' && apiKey.value.trim() ? { openaiKey: apiKey.value.trim() } : {}),
    });
    showProvider(provider);
    setStatus(replyStatus, provider === 'openai' ? 'IA online selecionada.' : 'Ollama selecionado.');
  } catch (error) { setStatus(replyStatus, error.message, true); }
}

$('#chooseOnline').addEventListener('click', () => choose('openai'));
$('#chooseOllama').addEventListener('click', () => choose('ollama'));

document.querySelectorAll('[data-personality]').forEach(field => field.addEventListener('input', () => {
  updatePersonalityCount();
  document.querySelectorAll('[data-preset]').forEach(button => button.setAttribute('aria-pressed', 'false'));
}));
$('#savePersonality').addEventListener('click', async () => {
  const button = $('#savePersonality');
  const id = savedPersonalities.value;
  const name = profileName.value.trim();
  if (!name) { setStatus($('#personalityStatus'), 'Dê um nome para esta personalidade.', true); return; }
  button.disabled = true;
  setStatus($('#personalityStatus'), 'Atualizando personalidade…');
  try {
    const result = await api('/api/personality-profiles', { action: 'update', id, name, fields: personalityValues() });
    applyPersonalityProfileResult(result);
    setStatus($('#personalityStatus'), 'Perfil atualizado e aplicado à Capri.');
  } catch (error) { setStatus($('#personalityStatus'), error.message, true); }
  finally { button.disabled = updatePersonalityCount() > 5000; }
});

$('#saveAsProfile').addEventListener('click', async () => {
  const name = profileName.value.trim();
  if (!name) { setStatus($('#personalityStatus'), 'Dê um nome para a nova personalidade.', true); return; }
  const button = $('#saveAsProfile');
  button.disabled = true;
  setStatus($('#personalityStatus'), 'Salvando uma nova personalidade…');
  try {
    const result = await api('/api/personality-profiles', { action: 'save_as', name, fields: personalityValues() });
    applyPersonalityProfileResult(result);
    setStatus($('#personalityStatus'), `“${name}” foi salva e aplicada.`);
  } catch (error) { setStatus($('#personalityStatus'), error.message, true); }
  finally { button.disabled = false; }
});

$('#applyProfile').addEventListener('click', async () => {
  const button = $('#applyProfile');
  button.disabled = true;
  setStatus($('#personalityStatus'), 'Aplicando personalidade…');
  try {
    const result = await api('/api/personality-profiles', { action: 'apply', id: savedPersonalities.value });
    applyPersonalityProfileResult(result);
    setStatus($('#personalityStatus'), 'Personalidade aplicada à Capri.');
  } catch (error) { setStatus($('#personalityStatus'), error.message, true); }
  finally { button.disabled = false; }
});

$('#deleteProfile').addEventListener('click', async () => {
  const selected = personalityProfiles.find(item => item.id === savedPersonalities.value);
  if (!selected || personalityProfiles.length <= 1) return;
  if (!window.confirm(`Excluir a personalidade “${selected.name}”?`)) return;
  const button = $('#deleteProfile');
  button.disabled = true;
  try {
    const result = await api('/api/personality-profiles', { action: 'delete', id: selected.id });
    applyPersonalityProfileResult(result);
    setStatus($('#personalityStatus'), 'Personalidade removida da lista.');
  } catch (error) { setStatus($('#personalityStatus'), error.message, true); }
  finally { button.disabled = personalityProfiles.length <= 1; }
});

function renderKnowledge(items) {
  knowledgeItems = items || [];
  const list = $('#knowledgeList');
  list.replaceChildren();
  const total = knowledgeItems.reduce((sum, item) => sum + item.text.length, 0);
  $('#knowledgeCount').textContent = `${knowledgeItems.length} / 30 · ${total} / 5000 caracteres`;
  if (!knowledgeItems.length) {
    const empty = document.createElement('div');
    empty.className = 'knowledge-empty';
    empty.textContent = 'Nenhuma anotação ainda. Escreva algo que você quer ensinar à Capri.';
    list.append(empty);
    return;
  }
  for (const item of knowledgeItems) {
    const row = document.createElement('article');
    row.className = 'knowledge-item';
    const content = document.createElement('p');
    content.textContent = item.text;
    const actions = document.createElement('div');
    actions.className = 'knowledge-item-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'secondary';
    edit.textContent = 'Editar';
    edit.addEventListener('click', () => {
      editingKnowledgeId = item.id;
      $('#knowledgeInput').value = item.text;
      $('#addKnowledge').textContent = 'Salvar anotação';
      $('#cancelKnowledgeEdit').hidden = false;
      $('#knowledgeInput').focus();
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary';
    remove.textContent = 'Excluir';
    remove.addEventListener('click', async () => {
      if (!window.confirm('Excluir esta anotação da Capri?')) return;
      remove.disabled = true;
      try {
        const result = await api('/api/knowledge', { action: 'delete', id: item.id });
        renderKnowledge(result.knowledge);
        setStatus($('#knowledgeStatus'), 'Anotação excluída.');
      } catch (error) { setStatus($('#knowledgeStatus'), error.message, true); remove.disabled = false; }
    });
    actions.append(edit, remove);
    row.append(content, actions);
    list.append(row);
  }
}

function cancelKnowledgeEdit() {
  editingKnowledgeId = null;
  $('#knowledgeInput').value = '';
  $('#addKnowledge').textContent = 'Adicionar à lista';
  $('#cancelKnowledgeEdit').hidden = true;
}

$('#cancelKnowledgeEdit').addEventListener('click', cancelKnowledgeEdit);
$('#addKnowledge').addEventListener('click', async () => {
  const text = $('#knowledgeInput').value.trim();
  if (!text) { setStatus($('#knowledgeStatus'), 'Escreva o que você quer ensinar à Capri.', true); return; }
  const button = $('#addKnowledge');
  button.disabled = true;
  setStatus($('#knowledgeStatus'), editingKnowledgeId ? 'Atualizando anotação…' : 'Salvando anotação…');
  try {
    const result = await api('/api/knowledge', { action: editingKnowledgeId ? 'update' : 'add', ...(editingKnowledgeId ? { id: editingKnowledgeId } : {}), text });
    renderKnowledge(result.knowledge);
    cancelKnowledgeEdit();
    setStatus($('#knowledgeStatus'), 'Anotação salva. Capri poderá usá-la nas próximas respostas.');
  } catch (error) { setStatus($('#knowledgeStatus'), error.message, true); }
  finally { button.disabled = false; }
});

$('#saveStyle').addEventListener('click', async () => {
  const button = $('#saveStyle');
  button.disabled = true;
  setStatus($('#styleStatus'), 'Salvando estilo…');
  try {
    await api('/api/response-style', { tone: $('#responseTone').value, length: $('#responseLength').value });
    setStatus($('#styleStatus'), 'Estilo salvo. Capri usará essas preferências nas próximas respostas.');
  } catch (error) { setStatus($('#styleStatus'), error.message, true); }
  finally { button.disabled = false; }
});

async function refreshStatus() {
  try {
    const result = await api('/api/status');
    speechReady = Boolean(result.speechReady);
    $('#microphoneButton').disabled = !speechReady;
    setStatus($('#microphoneStatus'), speechReady ? 'Reconhecimento local pronto.' : 'Instale o modelo de voz local para começar.');
    const profiles = result.personalityProfiles || [{ id: 'current', name: 'Personalidade atual', fields: result.personality || {} }];
    renderPersonalityProfiles(profiles, result.activePersonalityId || profiles[0]?.id);
    renderKnowledge(result.knowledge || []);
    $('#responseTone').value = result.responseStyle?.tone || 'natural';
    $('#responseLength').value = result.responseStyle?.length || 'short';
    const models = result.ollamaModels || [];
    modelSelect.replaceChildren();
    if (!models.length) {
      modelSelect.add(new Option('Nenhum modelo encontrado', ''));
      setStatus($('#ollamaStatus'), 'Abra o Ollama e verifique se já há um modelo baixado.', true);
    } else {
      for (const model of models) modelSelect.add(new Option(model, model));
      setStatus($('#ollamaStatus'), `${models.length} modelo(s) disponível(is).`);
    }
    if (result.settings.model) {
      if (result.settings.provider === 'openai') onlineModel.value = result.settings.model;
      else if (models.includes(result.settings.model)) modelSelect.value = result.settings.model;
    }
    if (result.settings.hasOpenAIKey) setStatus(replyStatus, 'Chave da API ativa nesta sessão.');
    $('#voiceStatus').textContent = result.voiceReady ? 'Voz neural local pronta: Dora · português brasileiro' : 'Voz neural ainda não instalada.';
    showProvider(result.settings.provider);
    refreshTwitchStatus();
  } catch {
    setStatus($('#ollamaStatus'), 'Servidor local indisponível. Inicie o Capri pelo arquivo Iniciar-avatar.bat.', true);
  }
}

function renderTwitchStatus(status) {
  if (!twitchFieldsLoaded) {
    $('#twitchClientId').value = status.clientId || '';
    $('#twitchChannel').value = status.channel || '';
    $('#twitchReplyMode').value = status.replyMode || 'mentions';
    twitchFieldsLoaded = true;
  }
  const connectedText = status.status === 'connected'
    ? `Conectada como ${status.login} ao canal ${status.channel}. ${status.replyMode === 'conversation' ? 'Modo conversa: agrupa até 20 mensagens e responde após 2,5 s sem novas mensagens.' : 'Modo menções: responde quando citarem a Capri.'}`
    : (status.message || 'Desconectada.');
  setStatus($('#twitchStatus'), connectedText, status.status === 'error' || status.status === 'authorization_required');
  $('#twitchStatus').classList.toggle('good', status.status === 'connected');
  $('#twitchUserCode').textContent = status.userCode || '';
  $('#twitchVerificationLink').href = status.verificationUri || 'https://www.twitch.tv/activate';
  $('#twitchAuthorization').hidden = !status.userCode;
  $('#disconnectTwitch').disabled = status.status === 'disconnected';
  $('#connectTwitch').disabled = status.status === 'authorizing' || status.status === 'connecting' || status.status === 'connected';
  $('#connectTwitch').textContent = status.status === 'connected' ? 'Conta conectada' : status.status === 'authorizing' ? 'Aguardando autorização…' : 'Conectar conta Twitch';
  if (twitchPollTimer) clearTimeout(twitchPollTimer);
  twitchPollTimer = setTimeout(refreshTwitchStatus, status.status === 'authorizing' ? 2000 : 10000);
}

function renderTwitchActivity(items) {
  const signature = items.map(item => item.id).join(',');
  $('#activityCount').textContent = items.length ? `${items.length} registro(s) recente(s)` : 'Aguardando mensagens';
  if (signature === twitchActivitySignature) return;
  twitchActivitySignature = signature;
  const feed = $('#twitchActivity');
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 36;
  feed.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'small';
    empty.textContent = 'As mensagens do chat aparecerão aqui quando a conexão estiver ativa.';
    feed.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = `activity-item ${item.kind === 'capri' ? 'capri' : 'viewer'}`;
    const time = document.createElement('time');
    time.textContent = item.time || '';
    const content = document.createElement('span');
    const sender = document.createElement('strong');
    sender.textContent = `${item.sender}: `;
    content.append(sender, document.createTextNode(item.message));
    row.append(time, content);
    feed.append(row);
  }
  if (nearBottom) feed.scrollTop = feed.scrollHeight;
}

async function refreshTwitchStatus() {
  try {
    const status = await api('/api/twitch/status');
    renderTwitchStatus(status);
  } catch {
    setStatus($('#twitchStatus'), 'Não foi possível verificar a conexão. Confira se o Capri está aberto.', true);
  }
}

async function refreshTwitchActivity() {
  try {
    const status = await api('/api/twitch/status');
    renderTwitchActivity(status.activity || []);
  } catch { /* O servidor pode estar reiniciando. */ }
  setTimeout(refreshTwitchActivity, 2500);
}

$('#connectTwitch').addEventListener('click', async () => {
  const button = $('#connectTwitch');
  button.disabled = true;
  setStatus($('#twitchStatus'), 'Pedindo autorização segura à Twitch…');
  try {
    const status = await api('/api/twitch/device', {
      clientId: $('#twitchClientId').value.trim(),
      channel: $('#twitchChannel').value.trim(),
      replyMode: $('#twitchReplyMode').value,
    });
    twitchFieldsLoaded = true;
    renderTwitchStatus(status);
  } catch (error) {
    setStatus($('#twitchStatus'), error.message, true);
    button.disabled = false;
  }
});

$('#disconnectTwitch').addEventListener('click', async () => {
  const button = $('#disconnectTwitch');
  button.disabled = true;
  try {
    const status = await api('/api/twitch/disconnect', {});
    renderTwitchStatus(status);
    setStatus($('#twitchStatus'), 'Twitch desconectada.');
  } catch (error) {
    setStatus($('#twitchStatus'), error.message, true);
    button.disabled = false;
  }
});

$('#twitchReplyMode').addEventListener('change', async () => {
  try {
    await api('/api/twitch/reply-mode', { replyMode: $('#twitchReplyMode').value });
    setStatus($('#twitchStatus'), 'Modo de resposta salvo.');
  } catch (error) { setStatus($('#twitchStatus'), error.message, true); }
});

async function sendMessage(message = $('#message').value.trim(), source = 'text') {
  if (!message) return;
  if (source === 'text') $('#message').value = '';
  addBubble(source === 'streamer' ? `Você (microfone): ${message}` : message, 'user');
  $('#send').disabled = true;
  setStatus(replyStatus, 'Capri está pensando…');
  try {
    const result = await api('/api/respond', { message, source });
    addBubble(result.event.answer, 'bot');
    const seconds = (result.event.generationMs / 1000).toFixed(1).replace('.', ',');
    setStatus(replyStatus, `Resposta enviada ao avatar em ${seconds} s. O tempo de fala depende do tamanho do texto.`);
  } catch (error) {
    setStatus(replyStatus, error.message, true);
  } finally { $('#send').disabled = false; if (source === 'text') $('#message').focus(); }
}

function encodeMonoWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const write = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

async function convertRecordingToWav(blob) {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const targetRate = 16000;
    const targetLength = Math.ceil(decoded.length * targetRate / decoded.sampleRate);
    const mono = new Float32Array(targetLength);
    for (let i = 0; i < targetLength; i++) {
      const position = i * decoded.sampleRate / targetRate;
      const left = Math.floor(position);
      const fraction = position - left;
      let sum = 0;
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const samples = decoded.getChannelData(channel);
        const a = samples[Math.min(left, samples.length - 1)] || 0;
        const b = samples[Math.min(left + 1, samples.length - 1)] || 0;
        sum += a + (b - a) * fraction;
      }
      mono[i] = sum / decoded.numberOfChannels;
    }
    return encodeMonoWav(mono, targetRate);
  } finally { await context.close(); }
}

async function finishRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  clearTimeout(microphoneTimeout);
  mediaRecorder.stop();
}

async function processRecording(blob) {
  try {
    setStatus($('#microphoneStatus'), 'Transcrevendo localmente…');
    const wav = await convertRecordingToWav(blob);
    const response = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não consegui transcrever a fala.');
    $('#microphoneTranscript').textContent = `Transcrição: ${result.text}`;
    setStatus($('#microphoneStatus'), 'Enviando sua fala para a Capri…');
    await sendMessage(result.text, 'streamer');
    setStatus($('#microphoneStatus'), 'Reconhecimento local pronto.');
  } catch (error) { setStatus($('#microphoneStatus'), error.message, true); }
  finally {
    microphoneBusy = false;
    $('#microphoneButton').disabled = !speechReady;
    $('#microphoneButton').textContent = 'Começar a falar';
  }
}

async function toggleMicrophoneRecording() {
  if (microphoneBusy) return;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') { await finishRecording(); return; }
  if (!speechReady) return setStatus($('#microphoneStatus'), 'O modelo local de voz ainda não está instalado.', true);
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return setStatus($('#microphoneStatus'), 'Este navegador não permite gravar áudio localmente.', true);
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    microphoneChunks = [];
    mediaRecorder = new MediaRecorder(microphoneStream);
    mediaRecorder.ondataavailable = event => { if (event.data.size) microphoneChunks.push(event.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(microphoneChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      microphoneStream?.getTracks().forEach(track => track.stop());
      microphoneStream = null; mediaRecorder = null; microphoneBusy = true;
      $('#microphoneButton').textContent = 'Processando…';
      void processRecording(blob);
    };
    mediaRecorder.start();
    $('#microphoneButton').textContent = 'Parar gravação';
    setStatus($('#microphoneStatus'), 'Gravando… clique para encerrar.');
    microphoneTimeout = setTimeout(() => { void finishRecording(); }, 15000);
  } catch (error) {
    microphoneStream?.getTracks().forEach(track => track.stop());
    microphoneStream = null;
    setStatus($('#microphoneStatus'), error.name === 'NotAllowedError' ? 'Permita o uso do microfone no navegador para conversar.' : error.message, true);
  }
}

$('#microphoneButton').addEventListener('click', toggleMicrophoneRecording);
window.addEventListener('beforeunload', () => microphoneStream?.getTracks().forEach(track => track.stop()));

document.querySelectorAll('[data-avatar-action]').forEach(button => button.addEventListener('click', async () => {
  const status = $('#avatarActionStatus');
  const controls = [...document.querySelectorAll('[data-avatar-action]')];
  controls.forEach(control => { control.disabled = true; });
  setStatus(status, 'Enviando comando ao avatar do OBS…');
  try {
    await api('/api/avatar/action', { action: button.dataset.avatarAction });
    setStatus(status, 'Comando enviado. Deixe a fonte Navegador do avatar aberta no OBS.');
  } catch (error) { setStatus(status, error.message, true); }
  finally { controls.forEach(control => { control.disabled = false; }); }
}));

$('#send').addEventListener('click', sendMessage);
$('#testVoice').addEventListener('click', async () => {
  const button = $('#testVoice');
  button.disabled = true;
  setStatus(replyStatus, 'Preparando uma amostra da voz neural…');
  try {
    const response = await fetch('/api/voice', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Oi, chat! Eu sou a Capri. Que bom ter vocês por aqui!' })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Não consegui gerar a voz.');
    const url = URL.createObjectURL(await response.blob());
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
    setStatus(replyStatus, 'Amostra da voz Dora em reprodução.');
  } catch (error) { setStatus(replyStatus, error.message, true); }
  finally { button.disabled = false; }
});
$('#message').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }
});
refreshStatus();
refreshTwitchActivity();
