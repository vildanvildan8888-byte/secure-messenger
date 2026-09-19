const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.json());

// База данных в памяти сервера для демонстрации
const users = {}; // socket.id -> { nickname, chats: [] }
const messages = {}; // chatId -> [ { sender, text, timestamp } ]

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="ru">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Secure Messenger - Live Network</title>
            <script src="/socket.io/socket.io.js"></script>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; display: flex; justify-content: center; align-items: center; height: 100vh; }
                .container { width: 100%; max-width: 400px; background: #1e293b; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); overflow: hidden; display: flex; flex-direction: column; height: 650px; box-sizing: border-box; }
                .screen { display: none; flex-direction: column; height: 100%; padding: 20px; box-sizing: border-box; overflow-y: auto; }
                .screen.active { display: flex; }
                input, select { width: 100%; padding: 12px; font-size: 16px; margin: 10px 0; border-radius: 8px; border: none; background: #334155; color: #fff; box-sizing: border-box; }
                button { background: #3b82f6; color: white; border: none; padding: 12px; width: 100%; border-radius: 8px; font-size: 16px; cursor: pointer; font-weight: bold; margin-top: 5px; }
                button:active { background: #2563eb; }
                .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 12px; margin-bottom: 15px; }
                .sos-btn { background: #ef4444; width: auto; padding: 6px 12px; font-size: 14px; border-radius: 6px; }
                .chat-item { background: #334155; padding: 12px; border-radius: 10px; margin-bottom: 10px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
                .chat-item:hover { background: #475569; }
                .nav-bar { display: flex; justify-content: space-around; border-top: 1px solid #334155; padding-top: 10px; margin-top: auto; }
                .nav-btn { background: transparent; color: #94a3b8; width: auto; font-size: 14px; cursor: pointer; border: none; }
                .nav-btn.active { color: #3b82f6; }
                label { font-size: 13px; color: #94a3b8; margin-top: 8px; display: block; text-align: left; }
                .msg-box { flex-grow: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
                .msg { background: #334155; padding: 8px 12px; border-radius: 8px; max-width: 80%; }
                .msg.me { background: #2563eb; align-self: flex-end; }
            </style>
        </head>
        <body onmousemove="resetInactivityTimer()" ontouchstart="resetInactivityTimer()" onkeypress="resetInactivityTimer()">

        <div class="container">
            <div id="regScreen" class="screen active">
                <h2>Добро пожаловать</h2>
                <p style="color: #94a3b8; font-size: 14px;">Придумайте никнейм для входа в сеть:</p>
                <input type="text" id="nicknameInput" placeholder="Ваш ник (например, Alex)">
                <button onclick="registerUser()">Подключиться к сети</button>
            </div>

            <div id="pinScreen" class="screen">
                <h2>Введите PIN-код</h2>
                <p style="color: #94a3b8; font-size: 14px;" id="pinHint">Введите основной или защитный PIN</p>
                <input type="password" id="pinInput" maxlength="6" placeholder="••••">
                <button onclick="checkPin()">Разблокировать</button>
            </div>

            <div id="messengerScreen" class="screen">
                <div class="header">
                    <h3 id="userNameTitle">Чаты</h3>
                    <button class="sos-btn" id="sosMainBtn" onclick="toggleSOS()">SOS</button>
                </div>
                
                <div style="display: flex; gap: 5px; margin-bottom: 10px;">
                    <input type="text" id="searchNick" placeholder="Найти ник..." style="margin: 0;">
                    <button onclick="searchUser()" style="width: auto; margin: 0; padding: 0 15px;">Найти</button>
                </div>

                <div id="chatListContainer" style="flex-grow: 1; overflow-y: auto;">
                    <p style="text-align: center; color: #64748b; margin-top: 50px;">Нет активных чатов. Найдите пользователя по нику выше.</p>
                </div>

                <div class="nav-bar">
                    <button class="nav-btn active">Чаты</button>
                    <button class="nav-btn" onclick="openSettings()">Настройки</button>
                    <button class="nav-btn" onclick="lockAppManually()">Заблокировать</button>
                </div>
            </div>

            <div id="chatScreen" class="screen">
                <div class="header">
                    <button onclick="backToChats()" style="width: auto; background: #334155; padding: 6px 10px; font-size: 14px;">⬅ Назад</button>
                    <h3 id="activeChatTitle">Чат</h3>
                    <div style="width: 40px;"></div>
                </div>
                <div class="msg-box" id="msgBox"></div>
                <div style="display: flex; gap: 5px;">
                    <input type="text" id="msgInput" placeholder="Сообщение..." style="margin: 0;">
                    <button onclick="sendMessage()" style="width: auto; margin: 0; padding: 0 15px;">➤</button>
                </div>
            </div>

            <div id="settingsScreen" class="screen">
                <div class="header">
                    <h3>Настройки безопасности</h3>
                    <button class="sos-btn" onclick="closeSettings()" style="background: #334155;">Назад</button>
                </div>
                
                <label>Основной PIN-код:</label>
                <input type="password" id="setMainPin" placeholder="1234">

                <label>Защитный PIN (Аварийная очистка):</label>
                <input type="password" id="setWipePin" placeholder="4321">

                <label>Автоматическая блокировка экрана:</label>
                <select id="autoLockSelect">
                    <option value="5">5 секунд</option>
                    <option value="10">10 секунд</option>
                    <option value="15" selected>15 секунд</option>
                    <option value="30">30 секунд</option>
                    <option value="60">60 секунд</option>
                </select>

                <button onclick="saveSettings()" style="background: #22c55e; margin-top: 20px;">Сохранить настройки</button>
            </div>
        </div>

        <script>
            const socket = io();
            let currentUser = '';
            let mainPin = '1234';
            let wipePin = '4321';
            let lockTimeoutSec = 15;
            let inactivityTimer = null;
            let sosActive = false;
            let activeRecipient = '';
            let myContacts = [];

            function registerUser() {
                const nick = document.getElementById('nicknameInput').value.trim();
                if (!nick) {
                    alert('Введите никнейм!');
                    return;
                }
                currentUser = nick;
                socket.emit('register', currentUser);
                
                document.getElementById('userNameTitle').innerText = 'Чаты (' + currentUser + ')';
                document.getElementById('setMainPin').value = mainPin;
                document.getElementById('setWipePin').value = wipePin;
                
                switchScreen('messengerScreen');
                startInactivityTimer();
            }

            function switchScreen(screenId) {
                document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
                document.getElementById(screenId).classList.add('active');
            }

            function searchUser() {
                const query = document.getElementById('searchNick').value.trim();
                if (!query || query === currentUser) return;
                socket.emit('search_user', query);
            }

            socket.on('search_result', (foundUser) => {
                if (foundUser) {
                    if (!myContacts.includes(foundUser)) {
                        myContacts.push(foundUser);
                        renderChats();
                    }
                    openChat(foundUser);
                } else {
                    alert('Пользователь не найден в сети!');
                }
            });

            function renderChats() {
                const container = document.getElementById('chatListContainer');
                if (myContacts.length === 0) {
                    container.innerHTML = '<p style="text-align: center; color: #64748b; margin-top: 50px;">Нет активных чатов. Найдите пользователя по нику выше.</p>';
                    return;
                }
                container.innerHTML = '';
                myContacts.forEach(contact => {
                    container.innerHTML += \`
                        <div class="chat-item" onclick="openChat('\${contact}')">
                            <b>\${contact}</b>
                            <span style="font-size: 12px; color: #3b82f6;">Открыть</span>
                        </div>
                    \`;
                });
            }

            function openChat(contact) {
                activeRecipient = contact;
                document.getElementById('activeChatTitle').innerText = contact;
                switchScreen('chatScreen');
                socket.emit('get_history', { recipient: contact });
            }

            function backToChats() {
                switchScreen('messengerScreen');
                renderChats();
            }

            function sendMessage() {
                const input = document.getElementById('msgInput');
                const text = input.value.trim();
                if (!text || !activeRecipient) return;

                socket.emit('send_message', { recipient: activeRecipient, text });
                input.value = '';
            }

            socket.on('receive_message', (data) => {
                if (data.from === activeRecipient || data.from === currentUser) {
                    const box = document.getElementById('msgBox');
                    const isMe = data.from === currentUser;
                    box.innerHTML += \`<div class="msg \${isMe ? 'me' : ''}"><b>\${data.from}:</b> \${data.text}</div>\`;
                    box.scrollTop = box.scrollHeight;
                }
                if (!myContacts.includes(data.from) && data.from !== currentUser) {
                    myContacts.push(data.from);
                    renderChats();
                }
            });

            socket.on('chat_history', (history) => {
                const box = document.getElementById('msgBox');
                box.innerHTML = '';
                history.forEach(msg => {
                    const isMe = msg.sender === currentUser;
                    box.innerHTML += \`<div class="msg \${isMe ? 'me' : ''}"><b>\${msg.sender}:</b> \${msg.text}</div>\`;
                });
                box.scrollTop = box.scrollHeight;
            });

            function checkPin() {
                const enteredPin = document.getElementById('pinInput').value;
                document.getElementById('pinInput').value = '';

                if (enteredPin === mainPin) {
                    switchScreen('messengerScreen');
                    renderChats();
                    startInactivityTimer();
                } else if (enteredPin === wipePin) {
                    switchScreen('messengerScreen');
                    myContacts = [];
                    renderChats();
                    socket.emit('emergency_wipe');
                    alert('⚠️ Выполнен аварийный сброс: локальная и серверная история удалены.');
                    startInactivityTimer();
                } else {
                    alert('Неверный PIN-код!');
                }
            }

            function openSettings() {
                switchScreen('settingsScreen');
                stopInactivityTimer();
            }

            function closeSettings() {
                switchScreen('messengerScreen');
                startInactivityTimer();
            }

            function saveSettings() {
                const mPin = document.getElementById('setMainPin').value.trim();
                const wPin = document.getElementById('setWipePin').value.trim();
                const lockTime = parseInt(document.getElementById('autoLockSelect').value);

                if (mPin.length < 3 || wPin.length < 3) {
                    alert('PIN-коды должны содержать минимум 3 символа!');
                    return;
                }
                mainPin = mPin;
                wipePin = wPin;
                lockTimeoutSec = lockTime;
                alert('Настройки сохранены!');
                closeSettings();
            }

            function lockAppManually() {
                stopInactivityTimer();
                document.getElementById('pinHint').innerText = 'Введите основной или защитный PIN';
                switchScreen('pinScreen');
            }

            function startInactivityTimer() {
                stopInactivityTimer();
                inactivityTimer = setTimeout(() => {
                    const activeScreen = document.querySelector('.screen.active').id;
                    if (activeScreen !== 'regScreen' && activeScreen !== 'pinScreen') {
                        lockAppManually();
                    }
                }, lockTimeoutSec * 1000);
            }

            function stopInactivityTimer() {
                if (inactivityTimer) {
                    clearTimeout(inactivityTimer);
                    inactivityTimer = null;
                }
            }

            function resetInactivityTimer() {
                const activeScreen = document.querySelector('.screen.active').id;
                if (activeScreen !== 'regScreen' && activeScreen !== 'pinScreen') {
                    startInactivityTimer();
                }
            }

            function toggleSOS() {
                sosActive = !sosActive;
                const btn = document.getElementById('sosMainBtn');
                if (sosActive) {
                    btn.style.background = '#22c55e';
                    btn.innerText = 'SOS (Фон)';
                    alert('SOS активирован! Передача координат пошла.');
                } else {
                    btn.style.background = '#ef4444';
                    btn.innerText = 'SOS';
                    alert('SOS остановлен.');
                }
            }
        </script>
        </body>
        </html>
    `);
});

// Логика веб-сокетов на сервере для реального времени
io.on('connection', (socket) => {
    socket.on('register', (nickname) => {
        users[socket.id] = { nickname, chats: [] };
    });

    socket.on('search_user', (query) => {
        let foundNick = null;
        for (let id in users) {
            if (users[id].nickname.toLowerCase() === query.toLowerCase()) {
                foundNick = users[id].nickname;
                break;
            }
        }
        socket.emit('search_result', foundNick);
    });

    socket.on('send_message', ({ recipient, text }) => {
        const senderObj = users[socket.id];
        if (!senderObj) return;
        const sender = senderObj.nickname;

        const chatId = [sender, recipient].sort().join('_');
        if (!messages[chatId]) messages[chatId] = [];
        const msgObj = { sender, text, timestamp: Date.now() };
        messages[chatId].push(msgObj);

        // Отправка обоим участникам
        socket.emit('receive_message', msgObj);
        for (let id in users) {
            if (users[id].nickname === recipient) {
                io.to(id).emit('receive_message', msgObj);
            }
        }
    });

    socket.on('get_history', ({ recipient }) => {
        const senderObj = users[socket.id];
        if (!senderObj) return;
        const sender = senderObj.nickname;
        const chatId = [sender, recipient].sort().join('_');
        socket.emit('chat_history', messages[chatId] || []);
    });

    socket.on('emergency_wipe', () => {
        const userObj = users[socket.id];
        if (!userObj) return;
        const nick = userObj.nickname;
        // Удаляем историю сообщений с участием этого юзера
        for (let chatId in messages) {
            if (chatId.includes(nick)) {
                delete messages[chatId];
            }
        }
    });

    socket.on('disconnect', () => {
        delete users[socket.id];
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
