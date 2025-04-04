const mysql = require('mysql2/promise');
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const token = process.env.BOT_TOKEN;
const channelId = process.env.CHANNEL_ID;
const moderatorChatId = process.env.MODERATOR_CHAT_ID;
const bot = new TelegramBot(token, { polling: true });
const AWAITING_PAYMENT_RECEIPT = 'awaiting_payment_receipt';
const AWAITING_DESCRIPTION = 'awaiting_description';
const AWAITING_PHOTOS = 'awaiting_photos';
// Создание пула соединений
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});
function sendMessageWithKeyboard(chatId, text, buttons) {
  return bot.sendMessage(chatId, text, {
    reply_markup: { inline_keyboard: buttons.map(button => [{ text: button.text, callback_data: button.callback_data }]) }
  });
}

// Функция для получения состояния пользователя из базы данных
async function getUserState(chatId) {
  const [rows] = await pool.query('SELECT * FROM posts WHERE user_chat_id = ?', [chatId]);
  return rows.map(row => {
    let photos = [];
    try {
      photos = row.photos ? JSON.parse(row.photos) : [];
    } catch (error) {
      console.error('Error parsing photos for post id ' + row.id, error);
    }
    return {
      ...row,
      photos,
      priceText: row.price_text, // Маппируем поле price_text в priceText
      username: row.username // Маппируем username
    };
  });
}

// Функция для сохранения состояния пользователя в базе данных
async function saveUserState(chatId, post) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    console.log("saveUserState: ", chatId, post);

    await connection.query(
      `INSERT INTO posts (id, user_chat_id, stage, photos, description, receipt, price, price_text, username, has_sent_instruction, photos_finished)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       stage = VALUES(stage),
       photos = VALUES(photos),
       description = VALUES(description),
       receipt = VALUES(receipt),
       price = VALUES(price),
       price_text = VALUES(price_text),
       username = VALUES(username),
       has_sent_instruction = VALUES(has_sent_instruction),
       photos_finished = VALUES(photos_finished)`,
      [
        post.id, // Используем оригинальный id поста
        chatId,
        post.stage,
        JSON.stringify(post.photos),
        post.description,
        post.receipt,
        post.price,
        post.priceText || null,
        post.username || 'Неизвестный пользователь',
        post.hasSentInstruction,
        post.photosFinished
      ]
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error('Error saving user state for chatId ' + chatId, error);
    throw error;
  } finally {
    connection.release();
  }
}
// Функция для отправки меню
function sendMenu(chatId) {
  const menuButtons = [
    { text: 'Продажа книг', callback_data: 'sell_books' },
    { text: 'Поиск', callback_data: 'search_books' }
  ];
  return sendMessageWithKeyboard(chatId, 'Привет! Выберите команду:', menuButtons);
}
// Функция для отправки кнопок выбора количества книг
function sendBookCountOptions(chatId) {
  const bookOptions = [
    { text: '1-4 книги - 5 грн', callback_data: 'books_1_4' },
    { text: '5-9 книг - 10 грн', callback_data: 'books_5_9' },
    { text: '10-14 книг - 15 грн', callback_data: 'books_10_14' },
    { text: '15-19 книг - 20 грн', callback_data: 'books_15_19' },
    { text: '20-24 книги - 25 грн', callback_data: 'books_20_24' },
    { text: '25-30 книг - 30 грн', callback_data: 'books_25_30' }
  ];
  return sendMessageWithKeyboard(chatId, 'Выберите количество книг:', bookOptions);
}
// Функция для обработки команды /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  let user = await getUserState(chatId);
  if (!user.length) {
    await pool.query('INSERT INTO users (chat_id, username) VALUES (?, ?) ON DUPLICATE KEY UPDATE username = ?', [chatId, msg.from.username, msg.from.username]);
    user = [];
  }
  try {
    await sendMenu(chatId);
  } catch (error) {
    console.error('Error sending menu:', error);
  }
});

// Функция для обработки кнопок
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  let user = await getUserState(chatId);

  try {
    if (query.data === 'sell_books') {
      const postId = Date.now();
      const username = query.from.username 
        ? `@${query.from.username}` // Используем username, если он доступен
        : query.from.first_name 
        ? `${query.from.first_name}${query.from.last_name ? ' ' + query.from.last_name : ''}` 
        : 'Неизвестный пользователь'; // Устанавливаем значение по умолчанию
      const newPost = {
        id: postId,
        stage: 'awaiting_book_count',
        photos: [],
        description: '',
        receipt: '',
        price: '',
        priceText: '',
        hasSentInstruction: false,
        username // Устанавливаем имя пользователя
      };
      user.push(newPost);
      await saveUserState(chatId, newPost); // Передаем только новый пост
      await sendBookCountOptions(chatId);
    } else if (query.data.startsWith('books_')) {
      const priceMap = {
        'books_1_4': { price: '5 грн', text: '1-4 книги - 5 грн' },
        'books_5_9': { price: '10 грн', text: '5-9 книг - 10 грн' },
        'books_10_14': { price: '15 грн', text: '10-14 книг - 15 грн' },
        'books_15_19': { price: '20 грн', text: '15-19 книг - 20 грн' },
        'books_20_24': { price: '25 грн', text: '20-24 книги - 25 грн' },
        'books_25_30': { price: '30 грн', text: '25-30 книг - 30 грн' }
      };

      const currentPost = user[user.length - 1];
      const selected = priceMap[query.data];
      currentPost.price = selected.price;
      currentPost.priceText = selected.text;
      currentPost.stage = AWAITING_PAYMENT_RECEIPT;

      await saveUserState(chatId, currentPost); // Передаем текущий пост
      await sendMessageWithKeyboard(chatId, `Вы выбрали ${selected.text}. Отправьте квитанцию об оплате.`, [
        { text: 'Назад', callback_data: 'back_to_book_count' }
      ]);
    } else if (query.data === 'back_to_book_count') {
      await sendBookCountOptions(chatId);
    } else if (query.data === 'search_books') {
      await bot.sendMessage(chatId, 'Функция поиска пока в разработке.');
    }else if (query.data === 'finish_photos') {
      const currentPost = user[user.length - 1];
      if (currentPost && currentPost.photos.length > 0) {
        clearTimeout(currentPost.photoNotificationTimer);
        currentPost.photosFinished = true;
        currentPost.stage = AWAITING_DESCRIPTION; 
        await saveUserState(chatId, currentPost); // Передаем текущий пост
        await bot.sendMessage(chatId, `Добавление фотографий завершено. Всего добавлено: ${currentPost.photos.length}. Теперь отправьте описание к вашему посту.`);
      } else {
        await bot.sendMessage(chatId, 'Вы не добавили ни одной фотографии. Пожалуйста, отправьте хотя бы одно фото.');
      }
    }  else {
      await handleModeratorActions(query);
    }

    await bot.answerCallbackQuery(query.id);
  } catch (error) {
    console.error('Error handling callback query:', error);
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  let user = await getUserState(chatId);
  if (user.length === 0) return;

  const currentPost = user[user.length - 1];
  try {
    if (currentPost.stage === AWAITING_PAYMENT_RECEIPT) {
      await handleReceipt(msg, chatId, currentPost);
    } else if (currentPost.stage === AWAITING_PHOTOS || currentPost.stage === AWAITING_DESCRIPTION) {
      await handlePhotosAndDescription(msg, chatId, currentPost);
    }

    await saveUserState(chatId, currentPost); // Передаем текущий пост
  } catch (error) {
    console.error('Error handling message:', error);
  }
});



async function sendPostForModeration(msg, post) {
  if (!post.photos || post.photos.length === 0) {
    await bot.sendMessage(msg.chat.id, 'Ошибка: нет фотографий для публикации.');
    return;
  }
  try {
    await bot.sendPhoto(moderatorChatId, post.receipt, {
      caption: `Количество книг: ${post.priceText || 'Не указано'}\nПользователь: ${post.username || 'Неизвестный пользователь'}\n\nВыберите действие:`,
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Опубликовать', callback_data: `approve_${msg.chat.id}_${post.id}` }],
          [{ text: 'Отклонить', callback_data: `reject_${msg.chat.id}_${post.id}` }]
        ]
      }
    });
  } catch (error) {
    console.error('Error sending post for moderation:', error);
    await bot.sendMessage(msg.chat.id, 'Произошла ошибка при отправке поста на модерацию. Пожалуйста, попробуйте еще раз.');
  }
}



// Обработка действий модератора (публикация или отклонение)
async function handleModeratorActions(query) {
  const [action, userChatId, postId] = query.data.split('_');
  let user = await getUserState(userChatId);
  const post = user.find(p => p.id == postId);
  if (post) {
    if (action === 'approve') {
      if (post.photos && post.photos.length > 0) {
        const mediaGroup = post.photos.map((photo, index) => ({
          type: 'photo',
          media: photo, 
          caption: index === 0 ? `${post.description}\n\nОпубликовал: ${post.username || 'Неизвестный пользователь'}` : ''
        }));

        try {
          await bot.sendMediaGroup(channelId, mediaGroup);
          await bot.sendMessage(userChatId, 'Ваш пост опубликован в канале.');
          post.stage = 'published'; // Меняем статус на published
        } catch (error) {
          console.error('Error sending media group:', error);
          await bot.sendMessage(userChatId, 'Произошла ошибка при публикации вашего поста. Пожалуйста, попробуйте еще раз.');
        }
      } else {
        await bot.sendMessage(userChatId, 'Ошибка: нет фотографий для публикации.');
      }
    } else if (action === 'reject') {
      await bot.sendMessage(userChatId, 'Ваш пост был отклонен модератором.');
      post.stage = 'rejected'; // Меняем статус на rejected
    }
    console.log("post: ", post);
    await saveUserState(userChatId, post); // Сохраняем обновленный статус поста
  }
  await bot.deleteMessage(query.message.chat.id, query.message.message_id); // Удаляем сообщение модератора
}

async function handlePhotosAndDescription(msg, chatId, post) {
  if (post.stage === AWAITING_PHOTOS) {
    // Текущее время для отслеживания группы сообщений
    const currentTime = Date.now();
    
    if (msg.photo) {
      // Добавляем фото в коллекцию
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      post.photos.push(photoId);
      
      // Инициализируем время группы сообщений, если это первое фото
      if (!post.messageGroupTime) {
        post.messageGroupTime = currentTime;
      }
      
      // Устанавливаем таймер для отправки уведомления после получения всех фото из группы
      clearTimeout(post.photoNotificationTimer);
      post.photoNotificationTimer = setTimeout(async () => {
        // Отправляем сообщение о полученных фото
        if (!post.hasSentInstruction) {
          await bot.sendMessage(chatId, `Получено ${post.photos.length} фото. Вы можете отправить еще фотографии или нажмите кнопку "Завершить добавление фото", чтобы перейти к добавлению описания.`, {
            reply_markup: {
              inline_keyboard: [
                [{ text: 'Завершить добавление фото', callback_data: 'finish_photos' }]
              ]
            }
          });
          post.hasSentInstruction = true;
        } else {
          await bot.sendMessage(chatId, `Добавлено еще фото. Всего: ${post.photos.length}. Нажмите "Завершить добавление фото", когда закончите.`, {
            reply_markup: {
              inline_keyboard: [
                [{ text: 'Завершить добавление фото', callback_data: 'finish_photos' }]
              ]
            }
          });
        }
        
        // Сбрасываем время группы сообщений
        post.messageGroupTime = null;
      }, 500); // Ждем 500 мс, чтобы собрать все фото из одной группы
    } else {
      await bot.sendMessage(chatId, 'Пожалуйста, отправьте фотографию или нажмите "Завершить добавление фото".');
    }
  } else if (post.stage === AWAITING_DESCRIPTION) {
    if (msg.text) {
      post.description = msg.text;
      post.stage = 'awaiting_moderation'; // Меняем статус на awaiting_moderation
      await sendPostForModeration(msg, post);
      await saveUserState(chatId, post); // Сохраняем обновленный пост
      
      // Сброс состояния пользователя
      await bot.sendMessage(chatId, 'Ваш пост отправлен на модерацию. Вы можете создать новый пост или выполнить поиск.');
      await sendMenu(chatId);
    } else {
      await bot.sendMessage(chatId, 'Пожалуйста, отправьте текстовое описание для вашего поста.');
    }
  }
}

// Функция для обработки квитанции
async function handleReceipt(msg, chatId, post) {
  if (msg.photo) {
    post.receipt = msg.photo[msg.photo.length - 1].file_id;
    post.stage = AWAITING_PHOTOS;
    await bot.sendMessage(chatId, 'Квитанция получена. Отправьте фотографии книг.');
  } else {
    await bot.sendMessage(chatId, 'Пожалуйста, отправьте квитанцию об оплате.');
  }
}