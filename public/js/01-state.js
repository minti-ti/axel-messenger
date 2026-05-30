/**
 * Axel Messenger — фронтенд, часть 01: State, DOM-ссылки, шифрование.
 *
 * До рефакторинга весь клиент жил в одном public/js/app.js на 4134 строки.
 * Теперь он разрезан на 4 файла, которые подключаются строго по порядку
 * (см. <script src='/js/0X-...js'> в public/index.html).
 *
 * Содержит: константы (COMMON_REACTIONS, EMOJI_SET, STICKER_SET, encryptionKeys), state (большой объект приложения), el (кэш ссылок на DOM-элементы), функции шифрования (storeEncryptionKey, getEncryptionKey, maybeDecryptMessage). Должен грузиться ПЕРВЫМ.
 *
 * ВАЖНО: модуль грузится как обычный <script>, без import/export. Все
 * объявленные тут переменные и функции остаются глобальными — так же,
 * как было в монолите. Это сознательное решение, чтобы рефакторинг
 * был safe-by-default (не меняет ни одной строки логики).
 */

const COMMON_REACTIONS = ['👍', '❤️', '🔥', '😂', '👏', '😮', '😢', '👀'];
const EMOJI_SET = ['😀','😁','😂','🤣','😊','😍','😎','🤔','😴','🥳','🤖','😇','😡','😭','🙏','👍','👎','🔥','❤️','💯','🎉','🚀','🌟','✅'];
const STICKER_SET = ['🐸','🐱','🐼','🦊','🐵','🐻','🦄','🐙','🍕','☕','🎉','🚀','❤️','🔥','✨','💥','🍔','🍩','🍉','🍓','🍰','🥐','🥳','💯'];

// Ключи шифрования для приватных чатов (chatId -> keyHex)
const encryptionKeys = new Map();

/**
 * Хранит ключ шифрования для приватного чата
 * Используется при расшифровке сообщений
 */
function storeEncryptionKey(chatId, keyHex) {
  if (keyHex) {
    encryptionKeys.set(chatId, keyHex);
  }
}

/**
 * Получает ключ шифрования для чата
 */
function getEncryptionKey(chatId) {
  return encryptionKeys.get(chatId);
}

/**
 * Расшифровывает сообщение если оно зашифровано
 */
async function maybeDecryptMessage(message) {
  if (!message.isEncrypted) return message;
  
  const key = getEncryptionKey(message.chatId);
  if (!key || !CryptoEncryption) {
    console.warn('Cannot decrypt message: missing key or crypto library');
    return { ...message, content: '[Зашифрованное сообщение]' };
  }
  
  try {
    const decrypted = await CryptoEncryption.decrypt(message.content, key);
    return { ...message, content: decrypted };
  } catch (error) {
    console.error('Decryption failed:', error);
    return { ...message, content: '[Ошибка расшифровки]' };
  }
}

const state = {
  token: localStorage.getItem('token') || '',
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  authUserExists: null,
  settings: {
    theme: 'dark',
    compactChats: false,
    sendOnEnter: true,
    showPreviews: true,
    phoneVisibility: 'everyone',
    lastSeenVisibility: 'everyone',
    allowUsernameLookup: true,
    accentColor: '#4da3ff',
    showFavoriteTab: true,
    showArchiveTab: true
  },
  chats: [],
  currentChat: null,
  messagesByChat: {},
  typingUsers: {},
  userSearchResults: [],
  searchQuery: '',
  chatFilter: 'all',
  replyTo: null,
  socket: null,
  presence: {},
  drawerOpen: false,
  mobileToolsOpen: false,
  selectMode: false,
  selectedMessageIds: [],
  chatFolders: JSON.parse(localStorage.getItem('chatFolders') || '[]'),
  folderSaveTimer: null,
  drafts: JSON.parse(localStorage.getItem('chatDrafts') || '{}'),
  pendingFiles: [],
  waveformCache: {},
  sendLongPressTriggered: false,
  mediaRecorder: null,
  recordingStream: null,
  draftSaveTimers: {},
  viewerImages: [],
  viewerIndex: -1,
  contextMenuOpen: false,
  renderMessageTimer: null,
  lastScrollPosition: 0
};

const el = {
  authScreen: document.getElementById('authScreen'),
  appScreen: document.getElementById('appScreen'),
  phoneInput: document.getElementById('phoneInput'),
  requestCodeBtn: document.getElementById('requestCodeBtn'),
  codeStep: document.getElementById('codeStep'),
  displayNameStep: document.getElementById('displayNameStep'),
  codeInput: document.getElementById('codeInput'),
  displayNameInput: document.getElementById('displayNameInput'),
  loginBtn: document.getElementById('loginBtn'),
  authModeHint: document.getElementById('authModeHint'),
  devCodeHint: document.getElementById('devCodeHint'),
  profileSummary: document.getElementById('profileSummary'),
  globalSearchInput: document.getElementById('globalSearchInput'),
  searchResults: document.getElementById('searchResults'),
  chatList: document.getElementById('chatList'),
  chatFilters: document.getElementById('chatFilters'),
  chatHeader: document.getElementById('chatHeader'),
  mobileBackBtn: document.getElementById('mobileBackBtn'),
  chatHeaderProfileBtn: document.getElementById('chatHeaderProfileBtn'),
  chatHeaderAvatar: document.getElementById('chatHeaderAvatar'),
  chatMeta: document.getElementById('chatMeta'),
  chatSearchBtn: document.getElementById('chatSearchBtn'),
  bulkSelectBtn: document.getElementById('bulkSelectBtn'),
  chatInfoBtn: document.getElementById('chatInfoBtn'),
  typingIndicator: document.getElementById('typingIndicator'),
  pinnedBar: document.getElementById('pinnedBar'),
  selectionBar: document.getElementById('selectionBar'),
  messageList: document.getElementById('messageList'),
  chatPanel: document.querySelector('.chat-panel'),
  composer: document.getElementById('composer'),
  composerSideActions: document.getElementById('composerSideActions'),
  mobileToolsBtn: document.getElementById('mobileToolsBtn'),
  mobileToolsOverlay: document.getElementById('mobileToolsOverlay'),
  fileInput: document.getElementById('fileInput'),
  attachBtn: document.getElementById('attachBtn'),
  attachBtnMobile: document.getElementById('attachBtnMobile'),
  emojiBtn: document.getElementById('emojiBtn'),
  stickerBtn: document.getElementById('stickerBtn'),
  messageInput: document.getElementById('messageInput'),
  replyBox: document.getElementById('replyBox'),
  pendingFilesBar: document.getElementById('pendingFilesBar'),
  toast: document.getElementById('toast'),
  imageViewer: document.getElementById('imageViewer'),
  imageViewerImg: document.getElementById('imageViewerImg'),
  imageViewerCaption: document.getElementById('imageViewerCaption'),
  imageViewerCount: document.getElementById('imageViewerCount'),
  closeImageViewerBtn: document.getElementById('closeImageViewerBtn'),
  prevImageBtn: document.getElementById('prevImageBtn'),
  nextImageBtn: document.getElementById('nextImageBtn'),
  contextMenu: document.getElementById('contextMenu'),
  modal: document.getElementById('modal'),
  modalTitle: document.getElementById('modalTitle'),
  modalBody: document.getElementById('modalBody'),
  closeModalBtn: document.getElementById('closeModalBtn'),
  newChatBtn: document.getElementById('newChatBtn'),
  newGroupBtn: document.getElementById('newGroupBtn'),
  newChannelBtn: document.getElementById('newChannelBtn'),
  quickSettingsBtn: document.getElementById('quickSettingsBtn'),
  menuToggleBtn: document.getElementById('menuToggleBtn'),
  leftDrawer: document.getElementById('leftDrawer'),
  drawerOverlay: document.getElementById('drawerOverlay'),
  drawerAvatar: document.getElementById('drawerAvatar'),
  drawerDisplayName: document.getElementById('drawerDisplayName'),
  drawerPhone: document.getElementById('drawerPhone'),
  drawerUsername: document.getElementById('drawerUsername'),
  drawerProfileBtn: document.getElementById('drawerProfileBtn'),
  drawerSettingsBtn: document.getElementById('drawerSettingsBtn'),
  drawerSavedBtn: document.getElementById('drawerSavedBtn'),
  drawerSearchMessagesBtn: document.getElementById('drawerSearchMessagesBtn'),
  drawerFoldersBtn: document.getElementById('drawerFoldersBtn'),
  drawerModerationBtn: document.getElementById('drawerModerationBtn'),
  drawerFavoritesBtn: document.getElementById('drawerFavoritesBtn'),
  drawerArchiveBtn: document.getElementById('drawerArchiveBtn'),
  drawerNewChatBtn: document.getElementById('drawerNewChatBtn'),
  drawerNewGroupBtn: document.getElementById('drawerNewGroupBtn'),
  drawerNewChannelBtn: document.getElementById('drawerNewChannelBtn'),
  drawerLogoutBtn: document.getElementById('drawerLogoutBtn'),
  recordVoiceBtn: document.getElementById('recordVoiceBtn'),
  sendBtn: document.getElementById('sendBtn')
};
