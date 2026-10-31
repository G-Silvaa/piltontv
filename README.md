# piltonTv

Sala para os amigos assistirem a tela uns dos outros. Tem voz e chat, roda direto no navegador e é grátis.

- Sem servidor próprio: a voz e a tela vão direto de um PC para o outro (WebRTC, via [PeerJS](https://peerjs.com)).
- Sem banco de dados: o chat some quando todo mundo sai.
- Funciona bem para 4 a 9 pessoas.

## Qualidade da transmissão

Quem transmite escolhe no seletor ao lado do botão "Compartilhar tela":

| Opção | Imagem | Upload por pessoa assistindo |
|---|---|---|
| Leve | 720p 30fps | ~2,5 Mbps (1,8 com 5+ pessoas) |
| **Alta** (padrão) | 1080p 30fps | ~6 Mbps (4 com 5+ pessoas) |
| Fluida (jogos) | 1080p 60fps | ~8 Mbps (5 com 5+ pessoas) |

O site mostra o upload estimado para o número de pessoas na sala.
Vídeo em VP9, áudio da transmissão em Opus estéreo 128 kbps.

**Para mandar o som:** no Chrome/Edge, escolha uma *aba* e marque "Compartilhar áudio da aba".
No Windows, compartilhando a tela inteira também aparece a opção de som do sistema.

## Rodar no seu PC

```bash
cd piltontv
python3 -m http.server 5173
# abra http://localhost:5173
```

## Colocar na Vercel (grátis)

**Pelo GitHub (recomendado):**
1. Crie um repositório no GitHub e envie esta pasta.
2. Em https://vercel.com/new, importe o repositório.
3. Framework Preset: **Other**. Não precisa de build. Clique em **Deploy**.
4. Mande para os amigos o link `https://seu-projeto.vercel.app/?sala=nome-da-sala`, ou use o botão "Convidar".

**Pelo terminal:**
```bash
npx vercel        # primeira vez: faz login e cria o projeto
npx vercel --prod
```

## Limitações

- Compartilhar a tela só funciona no computador (Chrome, Edge ou Firefox). No celular dá para assistir.
- Quem não sabe o nome da sala não entra, mas não existe senha. Use um nome difícil de adivinhar.
