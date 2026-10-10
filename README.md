# Pátio

Site e painel para lojas de veículos.

- `/` e `/painel`: levam direto para o test drive (`/teste`).
- `/teste`: test drive de 48 horas, com dados salvos no servidor (Cloudflare D1).
- `/l/<loja>`: site da loja em teste. `/l/<loja>/painel`: painel da loja.
- `/admin`: acompanhamento dos testes (senha na variável `ADMIN_SENHA`).

## Cloudflare Pages
- Sem comando de build; pasta de saída: raiz do repositório.
- Ligação D1 com o nome `DB`. As tabelas são criadas sozinhas na primeira chamada.
- Variável secreta `ADMIN_SENHA` para a página `/admin`.
- O servidor fica em `functions/api/[fn].js`.
