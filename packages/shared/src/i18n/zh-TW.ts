/**
 * The only file in this repository that holds interface copy.
 *
 * Everything a user reads is resolved from here by key. Adding a Chinese
 * string literal anywhere else breaks the language rule (spec 13.1) and the
 * CI scan will reject it.
 *
 * Note this covers copy written *for* users. Text typed *by* users — a baby's
 * nickname, an event note, a tag name — is data and is never translated,
 * normalised or filtered.
 */

export const zhTW = {
  app: {
    name: '東凡',
    noValue: '--',
    loading: '載入中…',
    noBaby: '這個帳號還沒有寶寶，請先用管理工具建立一個。',
  },

  auth: {
    title: '登入',
    username: '帳號',
    password: '密碼',
    submit: '登入',
    pending: '登入中…',
    signOut: '登出',
  },

  /** Labels read aloud by screen readers; invisible, but still user-facing. */
  a11y: {
    openMenu: '切換頁面',
    openSettings: '設定',
    addEvent: '新增事件',
    back: '返回',
  },

  category: {
    food: '食物',
    activity: '活動',
    growth: '成長速度',
    health: '健康狀況',
    mood: '情緒',
    milestone: '重要事件',
    other: '其他',
  },

  eventType: {
    nursing: '哺乳',
    bottle: '奶瓶',
    solid_food: '副食品',
    pumping: '擠奶',
    diaper: '尿布',
    sleep: '睡眠',
    walk: '散步',
    bath: '洗澡',
    play: '玩耍',
    weight: '體重',
    height: '身高',
    head_circ: '頭圍',
    doctor_visit: '看醫生',
    vaccine: '注射疫苗',
    temperature: '體溫',
    illness: '所患疾病',
    medicine: '服用藥物',
    mood_happy: '開朗',
    mood_neutral: '一般',
    mood_sad: '悲傷',
    mood_crying: '哭泣',
    milestone: '里程碑',
    other: '其他',
    unknown: '未知事件',
  },

  /** Labels for the numeric field on types that have one. */
  valueLabel: {
    bottle: '奶量',
    pumping: '擠出量',
    weight: '體重',
    height: '身高',
    head_circ: '頭圍',
    temperature: '體溫',
  },

  metadata: {
    side: '哺乳邊',
    'side.left': '左邊',
    'side.right': '右邊',
    'side.both': '兩邊',
    diaper_kind: '類型',
    'diaper_kind.pee': '尿',
    'diaper_kind.poo': '便',
    'diaper_kind.both': '兩者',
    food_name: '食物名稱',
    place: '地點',
    reason: '原因',
    vaccine_name: '疫苗名稱',
    illness_name: '疾病名稱',
    medicine_name: '藥物名稱',
    title: '名稱',
  },

  home: {
    age: '{months} 個月 {days} 天',
    height: '身高',
    weight: '體重',
    lastFeed: '上次餵奶',
    todayMilk: '今日奶量',
    todayDiaper: '今日尿布',
    diaperBreakdown: '尿{pee} · 便{poo} · 未分類{unknown}',
    todayEvents: '今日事件',
    eventCount: '{count} 筆',
    syncedAt: '{minutes} 分鐘前同步',
    syncedJustNow: '剛剛同步',
    emptyTitle: '今天還沒有紀錄',
    emptyHint: '點右下角的 ＋ 開始',
    syncing: '同步中…',
    syncFailed: '同步失敗',
  },

  timer: {
    running: '{name}中',
    stop: '結束',
    overrun: '{name}已逾 24 小時',
    confirmEnd: '確認結束時間',
    stopFailed: '結束計時失敗',
    justNow: '剛剛',
    neverHappened: '還沒有',
    longAgo: '很久以前',
    minutesAgo: '{minutes} 分鐘前',
    hoursAgo: '{hours} 小時前',
    daysAgo: '{days} 天前',
  },

  event: {
    allDay: '整天',
    inProgress: '進行中',
    duration: '{hours} 小時 {minutes} 分',
    durationMinutes: '{minutes} 分',
    edit: '編輯紀錄',
    deleteConfirm: '確定要刪除這筆紀錄嗎？刪除後另一支手機也會一起移除。',
    deleteConfirmYes: '刪除',
    open: '開啟 {name} 的紀錄',
  },

  addEvent: {
    title: '新增事件',
    startTimer: '開始計時',
    record: '補登紀錄',
    intentHint: '「開始計時」會占用同類型的進行中名額，另一人不能同時開始；「補登紀錄」不會。',
    startedAt: '開始時間',
    endedAt: '結束時間',
    endedAtPlaceholder: '計時中 — 結束時自動填入',
    note: '註解',
    notePlaceholder: '選填',
    tags: '標籤',
    addTag: '＋ 新增',
    save: '儲存',
    saving: '儲存中…',
    cancel: '取消',
    delete: '刪除',
    endNow: '設為現在',
    outcomeUnknown: '上次送出後沒有收到回應，不確定伺服器上有沒有這筆。請按重試確認，不要重新輸入一次。',
    retry: '重試送出',
    clearEnd: '清除',
    endedAtEmpty: '尚未填寫',
  },

  conflict: {
    body: '你的變更尚未儲存。重新載入後可再編輯一次。',
    reload: '重新載入',
  },

  error: {
    UNAUTHENTICATED: '請重新登入',
    FORBIDDEN: '沒有權限進行這個操作',
    NOT_FOUND: '找不到這筆資料',
    VERSION_CONFLICT: '這筆資料已被其他人修改',
    ID_CONFLICT: '這個紀錄編號已經用在別的寶寶身上',
    VALIDATION_FAILED: '輸入有誤，請檢查標示的欄位',
    RATE_LIMITED: '操作太頻繁，請稍後再試',
    DAILY_LIMIT_EXCEEDED: '今日新增數量已達上限',
    ACTIVE_TIMER_EXISTS: '對方已經開始記錄這個項目',
    INTERNAL: '伺服器發生錯誤，請稍後再試',
    UNKNOWN: '發生未預期的錯誤，請稍後再試',
    offline: '目前離線，無法完成這個操作',
    retry: '重試',
  },

  fieldError: {
    REQUIRED: '此欄位必填',
    OUT_OF_RANGE: '請輸入 {min} 到 {max} 之間的數值',
    TOO_LONG: '最多 {maxLength} 個字',
    NOT_INTEGER: '請輸入整數',
    INVALID_ENUM: '請從清單中選擇',
    UNKNOWN_FIELD: '不支援的欄位',
    INVALID_FORMAT: '格式不正確',
    END_BEFORE_START: '結束時間不可早於開始時間',
    DURATION_TOO_LONG: '單筆紀錄不可超過 {maxHours} 小時',
    TOO_FAR_IN_FUTURE: '時間不可超過 {maxDays} 天之後',
    BEFORE_BIRTH: '時間不可早於寶寶的出生日',
    UNKNOWN: '輸入有誤',
  },
} as const;
