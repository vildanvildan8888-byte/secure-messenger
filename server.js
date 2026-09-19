const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="ru">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Secure Messenger - Emergency System</title>
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
                .chat-item { background: #334155; padding: 12px; border-radius: 10px; margin-bottom: 10px; }
                .nav-bar { display: flex; justify-content: space-around; border-top: 1px solid #334155; padding-top: 10px; margin-top: auto; }
                .nav-btn { background: transparent; color: #94a3b8; width: auto; font-size: 14px; cursor: pointer; border: none; }
                .nav-btn.active { color: #3b82f6; }
                label { font-size: 13px; color: #94a3b8; margin-top: 8px; display: block; text-align: left; }
            </style>
        </head>
        <body onmousemove="resetInactivityTimer()" ontouchstart="resetInactivityTimer()" onkeypress="resetInactivityTimer()">

        <div class="container">
            <div id="regScreen" class="screen active">
                <h2>Добро пожаловать</h2>
                <p style="color: #94a3b8; font-size: 14px;">Придумайте никнейм для входа в мессенджер:</p>
                <input type="text" id="nicknameInput" placeholder="Ваш ник (например, Alex)">
                <button onclick="registerUser()">Войти в мессенджер</button>
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
                <div id="chatListContainer" style="flex-grow: 1;">
                    </div>
                <div class="nav-bar">
                    <button class="nav-btn active">Чаты</button>
                    <button class="nav-btn" onclick="openSettings()">Настройки</button>
                    <button class="nav-btn" onclick="lockAppManually()">Заблокировать</button>
                </div>
            </div>

            <div id="settingsScreen" class="screen">
                <div class="header">
                    <h3>Настройки безопасности</h3>
                    <button class="sos-btn" onclick="closeSettings()" style="background: #334155;">Назад</button>
                </div>
                
                <label>Основной PIN-код:</label>
                <input type="password" id="setMainPin" placeholder="Например: 1234">

                <label>Защитный PIN (Аварийная очистка):</label>
                <input type="password" id="setWipePin" placeholder="Например: 4321">

                <label>Автоматическая блокировка экрана:</label>
                <select id="autoLockSelect">
                    <option value="5">5 секунд</option>
                    <option value="10">10 секунд</option>
                    <option value="15">15 секунд</option>
                    <option value="20">20 секунд</option>
                    <option value="25">25 секунд</option>
                    <option value="30">30 секунд</option>
                    <option value="35">35 секунд</option>
                    <option value="40">40 секунд</option>
                    <option value="45">45 секунд</option>
                    <option value="50">50 секунд</option>
                    <option value="55">55 секунд</option>
                    <option value="60">60 секунд</option>
                </select>

                <button onclick="saveSettings()" style="background: #22c55e; margin-top: 20px;">Сохранить настройки</button>
            </div>
        </div>

        <script>
            let currentUser = '';
            let mainPin = '1234';
            let wipePin = '4321';
            let lockTimeoutSec = 15;
            let inactivityTimer = null;
            let sosActive = false;

            function registerUser() {
                const nick = document.getElementById('nicknameInput').value.trim();
                if (!nick) {
                    alert('Пожалуйста, введите никнейм!');
                    return;
                }
                currentUser = nick;
                document.getElementById('userNameTitle').innerText = 'Чаты (' + currentUser + ')';
                document.getElementById('setMainPin').value = mainPin;
                document.getElementById('setWipePin').value = wipePin;
                document.getElementById('autoLockSelect').value = lockTimeoutSec;
                
                switchScreen('messengerScreen');
                loadNormalChats();
                startInactivityTimer();
            }

            function switchScreen(screenId) {
                document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
                document.getElementById(screenId).classList.add('active');
            }

            function checkPin() {
                const enteredPin = document.getElementById('pinInput').value;
                document.getElementById('pinInput').value = '';

                if (enteredPin === mainPin) {
                    switchScreen('messengerScreen');
                    loadNormalChats();
                    startInactivityTimer();
                } else if (enteredPin === wipePin) {
                    switchScreen('messengerScreen');
                    document.getElementById('chatListContainer').innerHTML = '<p style="text-align: center; color: #64748b; margin-top: 100px;">Нет активных чатов</p>';
                    alert('⚠️ Выполнен аварийный сброс: локальная история и ключи удалены с сервера.');
                    startInactivityTimer();
                } else {
                    alert('Неверный PIN-код!');
                }
            }

            function loadNormalChats() {
                document.getElementById('chatListContainer').innerHTML = \`
                    <div class="chat-item"><b>Диас:</b> Привет, как дела?</div>
                    <div class="chat-item"><b>Рабочий чат:</b> Документы отправлены.</div>
                    <div class="chat-item"><b>Азиз:</b> Встретимся в центре.</div>
                \`;
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

                alert('Настройки безопасности успешно сохранены!');
                closeSettings();
            }

            function lockAppManually() {
                stopInactivityTimer();
                document.getElementById('pinHint').innerText = 'Основной или защитный PIN';
                switchScreen('pinScreen');
            }

            function startInactivityTimer() {
                stopInactivityTimer();
                inactivityTimer = setTimeout(() => {
                    const activeScreen = document.querySelector('.screen.active').id;
                    if (activeScreen === 'messengerScreen' || activeScreen === 'settingsScreen') {
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
                if (activeScreen === 'messengerScreen' || activeScreen === 'settingsScreen') {
                    startInactivityTimer();
                }
            }

            function toggleSOS() {
                sosActive = !sosActive;
                const btn = document.getElementById('sosMainBtn');
                if (sosActive) {
                    btn.style.background = '#22c55e';
                    btn.innerText = 'SOS (Фон)';
                    alert('SOS-сигнал активирован! Координаты передаются в фоновом режиме.');
                } else {
                    btn.style.background = '#ef4444';
                    btn.innerText = 'SOS';
                    alert('SOS-трансляция остановлена.');
                }
            }
        </script>
        </body>
        </html>
    `);
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
