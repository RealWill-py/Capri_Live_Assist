# Avatar do chatbot de stream

Esta etapa exibe o modelo Capri em uma página transparente. O arquivo do personagem traz cinco clipes: repouso, falar, rir, pensar e saudar/teletransportar. A rotina da versão original também cria movimentos de sono, surpresa, tédio e passeio a partir do esqueleto do mesmo personagem. O painel pode disparar esses estados, iniciar um glitch ou demonstrar tudo em sequência. Capri escolhe movimentos aleatórios após períodos de repouso; às vezes desliza pelo quadro e, ocasionalmente, teletransporta-se para outra posição com glitch.

## Pré-visualizar

Inicie `Iniciar-avatar.bat` com dois cliques e mantenha a janela aberta enquanto usar o avatar. O servidor local também recebe as mensagens de teste e encaminha as respostas à página do OBS.

- Painel de teste: `http://localhost:8000/painel.html`
- Avatar no OBS: `http://localhost:8000/?overlay=1`
- A página do avatar precisa de internet para carregar Three.js pelo CDN.
- Ollama usa `http://127.0.0.1:11434` e requer que o aplicativo Ollama esteja aberto com ao menos um modelo instalado. O modelo local padrão agora é `qwen3:4b-instruct`.
- IA online usa uma chave da API. A chave digitada no painel fica apenas na memória do servidor local; não é salva em arquivo. O uso da API pode gerar cobrança na conta do provedor.
- O Ollama mantém o modelo carregado por dez minutos entre mensagens. O tamanho configurado no painel define o limite da resposta e pode variar de 40 a 128 tokens.
- A fala usa a voz neural local Dora (`pf_dora`) em português brasileiro, via Kokoro. O modelo INT8 e os pacotes de voz ficam em `voices/`; o runtime Python 3.12 fica em `work/voice-runtime/`.
- No painel, ajuste o tom e o tamanho das respostas na aba **Inteligência**. Na aba **Personalidade**, salve diferentes perfis com nome, alterne entre eles e edite o jeito de ser, a história, os vínculos e os limites da Capri. Os perfis ficam neste computador em `capri-personality.json`; o estilo das respostas fica em `capri-response-style.json`. Ambos valem para o Ollama e para a IA online.
- Durante uma resposta, Capri pensa enquanto o modelo gera o texto; ao falar, faz um aceno em cumprimentos e ri quando detecta risadas. Os demais controles permitem experimentar cada animação.
- A aba **Twitch** conecta ao chat por IRC seguro. Registre um aplicativo no painel de desenvolvedor, cole o Client ID e autorize a conta que vai enviar as mensagens. São solicitados apenas `chat:read` e `chat:edit`; o token fica em memória e será preciso autorizar novamente depois de reiniciar o Capri.
- Por padrão, Capri responde quando alguém a menciona. No modo de conversa, ela agrupa até 20 mensagens recentes (ou espera 2,5 segundos sem novas mensagens), entende o contexto do grupo e envia uma resposta única.
- Na aba de teste, clique em **Começar a falar** para conversar com Capri pelo microfone; a gravação para ao clicar de novo ou após 15 segundos. A transcrição em português é feita localmente com Vosk, e sua fala entra no mesmo contexto das mensagens da Twitch.
- A Capri lê o chat da Twitch e, no modo de conversa, responde ao contexto de cada grupo recente. As mensagens do chat e as falas do streamer compartilham o contexto recente.
- Ative **Controlar áudio via OBS** nas propriedades da fonte Navegador para que a voz neural seja capturada na transmissão.

Se você já estava usando o servidor antigo, feche-o com Ctrl+C e abra o `Iniciar-avatar.bat` atualizado. Se o OBS já estiver aberto, atualize a fonte Navegador depois de iniciar o servidor.

## Adicionar ao OBS

Crie uma fonte **Navegador** e use `http://localhost:8000/?overlay=1`, com largura `1920` e altura `1080` para uma transmissão Full HD. A página mantém a resolução e o fundo transparente; Capri começa no canto inferior direito e ocupa cerca de um terço da altura do quadro. No OBS, clique com o botão direito na fonte, escolha **Interagir** e arraste a personagem para reposicioná-la; dê duplo clique nela para voltar ao canto inicial. A posição escolhida fica salva neste computador. A legenda aparece no canto inferior esquerdo. Para acionar o avatar, mantenha essa fonte aberta no OBS e use os controles **Animações do avatar** no painel `http://localhost:8000/painel.html`.

## Integração do avatar

O avatar expõe `window.capriAvatar` para a próxima etapa:

- `capriAvatar.setState('idle' | 'talk' | 'laugh' | 'wave' | 'think' | 'sleep' | 'walk' | 'surprise' | 'bored' | 'demo' | 'glitch')`
- `capriAvatar.speak('texto que aparece na legenda')`
- `capriAvatar.stopSpeaking()`

O painel envia as respostas ao avatar e usa a voz neural Dora. A transcrição local do microfone usa o modelo português brasileiro pequeno do Vosk, instalado em `speech-models/`; o modelo é baixado separadamente e não precisa de internet durante o reconhecimento.
