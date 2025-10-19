import React, { useEffect, useState, useRef, useCallback } from 'react'

function generateRandomPincode() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

function formatDeliveredTime(deliveredTime) {
  if (!deliveredTime) return ''
  const date = new Date(Number(deliveredTime))
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

// SVGアイコンコンポーネント
function PersonIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" />
    </svg>
  )
}

function GroupIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M16 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8z" />
      <circle cx="18" cy="10" r="3" />
    </svg>
  )
}

function OpenchatIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function HamburgerIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function ImageIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 1a3 3 0 0 0-3 3v12a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2m14 0H5m7 12v-4m-4 4h8m-4-4h0" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

export default function App() {
  // terms/login
  const [termsText, setTermsText] = useState('')
  const [showTerms, setShowTerms] = useState(false)
  const [ageCheck, setAgeCheck] = useState(false)
  const [termsCheck, setTermsCheck] = useState(false)

  // auth
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [sessionId, setSessionId] = useState('')

  // UI state
  const [showLoginModal, setShowLoginModal] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showImageModal, setShowImageModal] = useState(false)
  const [modalImageSrc, setModalImageSrc] = useState('')
  const [activeTab, setActiveTab] = useState('all') // 'all', 'friends', 'groups', 'openchat'

  // chats/messages
  const [chats, setChats] = useState([])
  const [selectedChat, setSelectedChat] = useState(null)
  const [chatEvents, setChatEvents] = useState([]) // flattened events displayed
  const lastMessageIds = useRef(new Set())

  // profile cache
  const profileCache = useRef(new Map())

  // sending / replying
  const [replyingToId, setReplyingToId] = useState(null)

  // settings
  const [readToggle, setReadToggle] = useState(false)
  const [repeatCount, setRepeatCount] = useState(1)
  const [repeatText, setRepeatText] = useState('')

  // pincode displays
  const [generatedPincode, setGeneratedPincode] = useState('')
  const [modalGeneratedPincode, setModalGeneratedPincode] = useState('')

  const pollingRef = useRef(null)

  // refs for inputs
  const messageRef = useRef(null)

  // load terms
  const loadTerms = useCallback(async () => {
    try {
      const res = await fetch('/terms.txt')
      const txt = await res.text()
      setTermsText(txt)
    } catch (e) {
      setTermsText('利用規約の読み込みに失敗しました。')
    }
  }, [])

  useEffect(() => {
    const agreed = localStorage.getItem('termsAgreed') === 'true'
    const version = localStorage.getItem('termsVersion')
    
    if (!agreed || version !== '1.0') {
      loadTerms()
      setShowTerms(true)
      setShowLoginModal(false)
      setIsLoggedIn(false)
    } else {
      // 利用規約に同意済みなので、セッションを確認
      setShowTerms(false)
      
      // ローカルストレージからセッションIDを取得
      const savedSessionId = localStorage.getItem('sessionId')
      
      if (savedSessionId) {
        // セッション確認APIを使用（sessionIdをボディに含める）
        fetch('/api/session', {
          method: 'GET',
          credentials: 'include',
        })
          .then(res => res.json())
          .then(data => {
            if (data.authenticated) {
              // セッション有効 - チャットリストを取得
              setSessionId(savedSessionId)
              fetch('/api/action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'squares', sessionId: savedSessionId }),
                credentials: 'include',
              })
                .then(res => res.json())
                .then(chatsData => {
                  if (chatsData.error || !Array.isArray(chatsData.result)) {
                    setShowLoginModal(true)
                    setIsLoggedIn(false)
                  } else {
                    setIsLoggedIn(true)
                    setShowLoginModal(false)
                    setChats(chatsData.result)
                  }
                })
                .catch(() => {
                  setShowLoginModal(true)
                  setIsLoggedIn(false)
                })
            } else {
              // セッション無効
              setShowLoginModal(true)
              setIsLoggedIn(false)
              // 無効なセッションを削除
              localStorage.removeItem('sessionId')
            }
          })
          .catch(() => {
            setShowLoginModal(true)
            setIsLoggedIn(false)
          })
      } else {
        // セッションIDがない場合はログイン画面を表示
        setShowLoginModal(true)
        setIsLoggedIn(false)
      }
    }
  }, [loadTerms])

  useEffect(() => {
    // start polling
    if (pollingRef.current) clearInterval(pollingRef.current)
    pollingRef.current = setInterval(() => {
      if (isLoggedIn && selectedChat) {
        const el = document.getElementById('rightPane')
        const autoScroll = el ? el.scrollHeight - el.scrollTop - el.clientHeight < 5 : true
        loadMessages(null, selectedChat.squareChatMid, autoScroll)
      }
    }, 3000) // 3秒ごとにポーリング（1000ms -> 3000ms）
    return () => clearInterval(pollingRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, selectedChat])

  async function callApi(body) {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include', // Cookieを含める
    })
    const data = await res.json()
    
    // セッション無効エラーの場合、自動ログアウト
    if (data.needsReauth || data.error === '認証エラー' || res.status === 401) {
      setIsLoggedIn(false)
      setShowLoginModal(true)
      setChats([])
      setSelectedChat(null)
      setChatEvents([])
      alert('セッションが無効です。再度ログインしてください。')
    }
    
    return data
  }

  async function handlePasswordLogin(email, password) {
    if (!email || !password) return alert('メールアドレスとパスワードを入力してください')
    const pincode = generateRandomPincode()
    setGeneratedPincode(pincode)

    try {
      const res = await fetch('/api/login/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, pincode }),
        credentials: 'include', // Cookieを含める
      })
      const result = await res.json()
      if (result.success) {
        // セッションIDを状態とローカルストレージに保存
        if (result.sessionId) {
          setSessionId(result.sessionId)
          localStorage.setItem('sessionId', result.sessionId)
        }
        setIsLoggedIn(true)
        setShowLoginModal(false)
        setGeneratedPincode('')
        
        // チャットリストを取得
        const data = await fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'squares', sessionId: result.sessionId }),
          credentials: 'include', // Cookieを含める
        }).then(res => res.json())
        
        if (Array.isArray(data.result)) {
          setChats(data.result)
          lastMessageIds.current.clear()
          setChatEvents([])
        }
      } else {
        alert(`ログインに失敗しました: ${result.error}`)
        setGeneratedPincode('')
      }
    } catch (err) {
      alert('エラーが発生しました: ' + (err.message || err))
      setGeneratedPincode('')
    }
  }

  async function getProfileIfNeeded(pid) {
    if (profileCache.current.has(pid)) return profileCache.current.get(pid)
    if (!selectedChat) return null
    try {
      const chatId = selectedChat.squareChatMid || selectedChat.squareChatMid
      const response = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'getProfile', pid, squareChatMid: chatId }),
        credentials: 'include', // Cookieを含める
      })
      const result = await response.json()
      
      // セッション無効エラーの場合、自動ログアウト
      if (result.needsReauth || result.error === '認証エラー' || response.status === 401) {
        setIsLoggedIn(false)
        setShowLoginModal(true)
        return null
      }
      
      if (result.success && result.profile) {
        profileCache.current.set(pid, result.profile)
        return result.profile
      }
    } catch (e) {
    }
    return null
  }

  async function loadMessages(sid, chatMid, scrollToBottom = false) {
    if (!chatMid) return
    try {
      const res = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'messages', squareChatMid: chatMid }),
        credentials: 'include', // Cookieを含める
      })
      const data = await res.json()
      
      // セッション無効エラーの場合、自動ログアウト
      if (data.needsReauth || data.error === '認証エラー' || res.status === 401) {
        setIsLoggedIn(false)
        setShowLoginModal(true)
        return
      }
      
      if (data.error) return
      if (!Array.isArray(data.events)) return

      const newEvents = []
      for (const e of data.events) {
        // 個人チャット/グループチャットの場合、直接メッセージ情報が入っている
        const msg = e.payload?.receiveMessage?.squareMessage?.message ?? 
                    e.payload?.sendMessage?.squareMessage?.message ??
                    e.payload?.message ?? 
                    e // 個人チャットの場合は e 自体がメッセージ情報
        
        const msgId = msg.id || (e.rawEvent?.payload?.message?.id) || e.id
        if (!msgId) continue
        
        if (!lastMessageIds.current.has(msgId)) {
          lastMessageIds.current.add(msgId)
          // enrich
          const isReceive = e.isReceive ?? (e.type === 'RECEIVE_MESSAGE')
          let profile = data.profiles?.[msg.from]
          if (isReceive && !profile && msg.from) profile = await getProfileIfNeeded(msg.from)
          newEvents.push({
            id: msgId,
            isReceive,
            text: e.text || msg.text || '',
            deliveredTime: e.deliveredTime || msg.deliveredTime,
            contentType: e.contentType || msg.contentType,
            messageRelationType: e.messageRelationType || msg.messageRelationType,
            relatedMessageId: e.relatedMessageId || msg.relatedMessageId,
            profile: e.profile || profile,
            rawEvent: e.rawEvent || e,
            imageData: e.imageData,
            isImage: !!e.isImage,
          })
        }
      }

      if (newEvents.length === 0) return
      setChatEvents(prev => [...prev, ...newEvents])

      if (scrollToBottom) {
        setTimeout(() => {
          const el = document.getElementById('rightPane')
          el?.lastElementChild?.scrollIntoView({ behavior: 'smooth' })
        }, 50)
      }
    } catch (e) {
      // エラーは無視（ポーリング中のエラーでUIを壊さない）
    }
  }

  async function handleSelectChat(chat) {
    setSelectedChat(chat)
    setChatEvents([])
    lastMessageIds.current.clear()
    // squareChatMidが無い場合は、chatMidを使用する
    const chatId = chat.squareChatMid || chat.squareChatMid
    await loadMessages(null, chatId, true)
  }

  async function sendMessage() {
    const text = messageRef.current?.value.trim() || ''
    if (!text || !selectedChat) return alert('全て入力してください')
    try {
      if (replyingToId) {
        await replyToMessage(replyingToId, text)
        setReplyingToId(null)
        if (messageRef.current) messageRef.current.value = ''
        return
      }
      const chatId = selectedChat.squareChatMid || selectedChat.squareChatMid
      const data = await callApi({ action: 'send', squareChatMid: chatId, text })
      if (data.message) {
        if (messageRef.current) messageRef.current.value = ''
        await loadMessages(null, chatId, true)
      } else if (data.error) alert(`エラー: ${data.message}`)
    } catch (err) {
      alert('メッセージ送信に失敗しました')
    }
  }

  async function replyToMessage(relatedMessageId, text) {
    if (!selectedChat || !text) return alert('必要な情報が不足しています')
    try {
      const chatId = selectedChat.squareChatMid || selectedChat.squareChatMid
      const data = await callApi({ action: 'replyToMessage', squareChatMid: chatId, text, relatedMessageId })
      if (data.message) {
        await loadMessages(null, chatId, true)
      } else if (data.error) alert(`エラー: ${data.message}`)
    } catch (e) {
      alert('リプライメッセージ送信に失敗しました')
    }
  }

  async function startRepeat() {
    if (!repeatText.trim()) return alert('文字列を入力してください')
    if (repeatCount < 1) return alert('回数は1以上にしてください')
    try {
      const chatId = selectedChat ? (selectedChat.squareChatMid || selectedChat.squareChatMid) : null
      const res = await fetch('/api/sends/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sendcount: repeatCount, squareChatMid: chatId, text: repeatText, read: readToggle }),
        credentials: 'include', // Cookieを含める
      })
      if (!res.ok) throw new Error(`送信エラー: ${res.status}`)
      const data = await res.json()
      if (!res.ok) throw new Error(`送信エラー: ${res.status}`)
      alert('連投送信が開始されました')
    } catch (err) {
      alert('送信に失敗しました')
    }
    setShowSettings(false)
  }

  function handleLogout() {
    // バックエンドでCookieをクリア
    fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logout', sessionId }),
      credentials: 'include',
    }).catch(() => {})
    
    // ローカルストレージからセッションIDを削除
    localStorage.removeItem('sessionId')
    
    setIsLoggedIn(false)
    setShowLoginModal(true)
    setChats([])
    setSelectedChat(null)
    setChatEvents([])
    setSessionId('')
  }

  function openImageModal(src) {
    setModalImageSrc(src)
    setShowImageModal(true)
  }

  function closeImageModal() {
    setShowImageModal(false)
    setModalImageSrc('')
  }

  return (
    <div>
      {/* Terms modal */}
      {showTerms && (
        <div id="termsModal" className="modal">
          <div className="modal-content">
            <h2>利用規約</h2>
            <div id="termsContent" className="terms-content">{termsText}</div>
            <div className="checkbox-container">
              <label>
                <input id="ageCheck" type="checkbox" checked={ageCheck} onChange={e => setAgeCheck(e.target.checked)} />
                私は18歳以上です
              </label>
            </div>
            <div className="checkbox-container">
              <label>
                <input id="termsCheck" type="checkbox" checked={termsCheck} onChange={e => setTermsCheck(e.target.checked)} />
                上記の利用規約に同意します
              </label>
            </div>
            <button id="agreeButton" disabled={!(ageCheck && termsCheck)} onClick={async () => {
              if (!(ageCheck && termsCheck)) return alert('すべての項目に同意しないとこのサービスは使えません。')
              const agreeButton = document.getElementById('agreeButton')
              const originalText = agreeButton.textContent
              try {
                agreeButton.disabled = true
                agreeButton.textContent = '同意処理中...'
                const response = await fetch('/api/terms-agreement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ageConfirmed: ageCheck, termsAgreed: termsCheck, userAgent: navigator.userAgent }) })
                const result = await response.json()
                if (result.success) {
                  localStorage.setItem('termsAgreed', 'true')
                  localStorage.setItem('termsVersion', '1.0')
                  setShowTerms(false)
                  setShowLoginModal(true)
                } else {
                  alert('同意処理に失敗しました')
                }
              } catch (err) {
                alert('同意処理中にエラーが発生しました')
              } finally {
                agreeButton.textContent = originalText
                agreeButton.disabled = false
              }
            }}>同意する</button>
          </div>
        </div>
      )}

      <div id="container" style={{ display: showTerms ? 'none' : 'flex', height: '100vh', width: '100%' }}>
        {/* ログイン画面はコンテナ全体を占める */}
        {showLoginModal ? (
          <div id="loginModal" className="login-mode" style={{ display: 'flex', width: '100%', height: '100%' }}>
            <div className="login-container">
              <div className="login-header"><h1>Rain-Web</h1></div>
              <div className="login-form">
                <div className="input-group">
                  <label htmlFor="modalEmail">メールアドレス</label>
                  <input id="modalEmail" type="email" placeholder="メールアドレスを入力してください" />
                </div>
                <div className="input-group">
                  <label htmlFor="modalPassword">パスワード</label>
                  <input id="modalPassword" type="password" placeholder="パスワードを入力してください" />
                </div>
                <div className="pincode-display" id="modalPincodeDisplay" style={{ display: generatedPincode ? 'block' : 'none' }}>
                  生成されたPINコード: <span id="modalGeneratedPincode">{generatedPincode}</span>
                </div>
                <button id="modalPasswordLogin" className="login-button" onClick={() => handlePasswordLogin(document.getElementById('modalEmail').value, document.getElementById('modalPassword').value)}>ログイン</button>
                <div id="modalResult" style={{ marginTop: 15, textAlign: 'center' }}></div>
              </div>
            </div>
          </div>
        ) : (
          <div id="leftPane">
            {/* Chat list area - only show when logged in */}
            {isLoggedIn && (
              <>
                <div className="left-pane-header">
                  <div className="left-pane-title">
                    <span>チャット</span>
                    <div className="header-buttons">
                      <button className="header-btn">+ DM</button>
                      <button className="header-btn">+ グループ</button>
                    </div>
                  </div>
                  <div className="search-bar">
                    <input type="text" className="search-input" placeholder="トークを検索..." />
                  </div>
                </div>
                <div className="tabs-container">
                  <button className={`tab-btn ${activeTab === 'all' ? 'active' : ''}`} onClick={() => setActiveTab('all')}>すべて</button>
                  <button className={`tab-btn ${activeTab === 'friends' ? 'active' : ''}`} onClick={() => setActiveTab('friends')}>友だち</button>
                  <button className={`tab-btn ${activeTab === 'groups' ? 'active' : ''}`} onClick={() => setActiveTab('groups')}>グループ</button>
                  <button className={`tab-btn ${activeTab === 'openchat' ? 'active' : ''}`} onClick={() => setActiveTab('openchat')}>オープンチャット</button>
                </div>
                <div id="chatButtons" tabIndex={0}>
                  {chats
                    .filter(chat => {
                      if (activeTab === 'all') return true
                      if (activeTab === 'friends') return chat.chatType === 'personal'
                      if (activeTab === 'groups') return chat.chatType === 'group'
                      if (activeTab === 'openchat') return chat.chatType === 'square' || chat.chatType === 'openchat'
                      return true
                    })
                    .map((chat, idx) => {
                    // チャットIDを統一的に取得
                    const chatId = chat.squareChatMid || chat.squareChatMid
                    const isActive = selectedChat?.squareChatMid === chatId
                    // チャットタイプのアイコン
                    const typeIcon = chat.chatType === 'personal' ? <PersonIcon /> : chat.chatType === 'group' ? <GroupIcon /> : <OpenchatIcon />
                    
                    return (
                      <button key={idx} className={`chat-button ${isActive ? 'active' : ''}`} onClick={() => handleSelectChat(chat)}>
                        <div className="chat-button-content">
                          <div className="chat-icon-container">
                            { (chat.chatImageObsHash || chat.chat?.chatImageObsHash) ? (
                              <img className="chat-icon" src={`https://obs.line-scdn.net/${chat.chatImageObsHash || chat.chat?.chatImageObsHash}/preview`} alt="" onError={e => e.currentTarget.style.display = 'none'} />
                            ) : (
                              <div className="chat-icon-placeholder" style={{ color: '#ffffff' }}>{typeIcon}</div>
                            ) }
                          </div>
                          <div className="chat-info">
                            <div className="chat-button-name">{chat.name || chat.chat?.name || 'Unknown'}</div>
                            <div className="chat-button-id">{(chatId || '').slice(0,8)}...</div>
                          </div>
                          <div className="chat-member-count">({chat.squareStatus?.memberCount || (chat.chatType === 'personal' ? 1 : 0)}人)</div>
                        </div>
                        <div className="chat-button-indicator" />
                      </button>
                    )
                  })}
                </div>
                <div style={{ padding: '12px 20px', borderTop: '1px solid #333', display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button onClick={handleLogout} style={{ padding: '8px 16px', background: '#3a3a3a', color: '#e1e1e1', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.9em' }}>ログアウト</button>
                  <button id="loadMessages" disabled={!selectedChat} onClick={() => {
                    if (!selectedChat) return
                    const chatId = selectedChat.squareChatMid || selectedChat.squareChatMid
                    loadMessages(null, chatId, true)
                  }} style={{ padding: '8px 16px', background: '#3a3a3a', color: '#e1e1e1', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.9em' }}>過去メッセージ</button>
                  <span id="messageCount" style={{ marginLeft: 8 }}></span>
                </div>
              </>
            )}
          </div>
        )}

        {isLoggedIn && (
          <div id="rightPaneWrapper">
            <div id="chatHeader" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span id="chatTitle">{selectedChat ? (selectedChat.name || selectedChat.chat?.name) : 'チャットが未選択です'}</span>
              <button id="settingsButton" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#e1e1e1' }} title="メニュー" onClick={() => setShowSettings(true)}>
                <HamburgerIcon />
              </button>
            </div>

          <div id="rightPane" tabIndex={0} style={{ padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div id="chatContent" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {chatEvents.map(evt => (
                <div key={evt.id} className="message-wrapper" style={{ display: 'flex', flexDirection: 'column', alignItems: evt.isReceive ? 'flex-start' : 'flex-end', gap: 4 }}>
                  {evt.profile && evt.isReceive && (
                    <div className="profile-header" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {evt.profile.pictureStatus && <img className="profile-icon" src={`https://obs.line-scdn.net/${evt.profile.pictureStatus}/preview`} alt="" onError={e => e.currentTarget.style.display = 'none'} />}
                      <span>{evt.profile.displayName || evt.profile.name || evt.id}</span>
                    </div>
                  )}

                  <div className={`message ${evt.isReceive ? 'left' : 'right'}`} data-message-id={evt.id} onClick={() => { setReplyingToId(evt.id); document.getElementById('replyBox').style.display = 'block'; document.getElementById('replyPreviewText').textContent = (evt.text || '画像').slice(0,30) + ((evt.text || '').length > 30 ? '...' : '') }}>
                    {evt.messageRelationType === 'REPLY' && evt.relatedMessageId && (
                      <div className="reply-preview" style={{ alignSelf: 'stretch' }} onClick={() => document.querySelector(`[data-message-id="${evt.relatedMessageId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
                        reply
                      </div>
                    )}
                    { (evt.text || evt.contentType === 0) && <div style={{ alignSelf: 'stretch' }}>{evt.text || 'その他'}</div> }
                    { evt.isImage && evt.imageData && evt.contentType !== 'VIDEO' && (
                      <img src={evt.imageData} className="media-content" alt="" onClick={e => { e.stopPropagation(); openImageModal(evt.imageData) }} onError={e => e.currentTarget.style.display = 'none'} />
                    ) }
                    { evt.isImage && evt.contentType === 'VIDEO' && evt.imageData && (
                      <video src={evt.imageData} controls className="media-content video" onError={e => e.currentTarget.style.display = 'none'} />
                    ) }
                  </div>

                  {evt.deliveredTime && <div className="message-time" style={{ fontSize: '0.75em', color: '#666', marginTop: 2 }}>{formatDeliveredTime(evt.deliveredTime)}</div>}
                </div>
              ))}
            </div>
          </div>

          <div id="replyBox" style={{ display: 'none', background: '#f1f1f1', padding: '6px 10px', borderLeft: '3px solid #888' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span id="replyPreviewText" style={{ fontSize: '0.85em', color: '#333' }}></span>
              <button id="cancelReply" style={{ background: 'none', border: 'none', padding: '2px', color: '#888', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => { setReplyingToId(null); document.getElementById('replyBox').style.display = 'none' }}>
                <CloseIcon />
              </button>
            </div>
          </div>

          <div id="sendArea">
            <button style={{ background: 'none', border: 'none', color: '#e1e1e1', cursor: 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="添付">
              <PlusIcon />
            </button>
            <button style={{ background: 'none', border: 'none', color: '#e1e1e1', cursor: 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="画像">
              <ImageIcon />
            </button>
            <div className="send-input-wrapper">
              <textarea id="message" ref={messageRef} placeholder="メッセージを入力" onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  sendMessage()
                }
              }}></textarea>
            </div>
            <button style={{ background: 'none', border: 'none', color: '#e1e1e1', cursor: 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="音声">
              <MicIcon />
            </button>
            <button style={{ background: 'none', border: 'none', color: '#06c755', cursor: 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="送信" onClick={sendMessage}>
              <SendIcon />
            </button>
          </div>
          </div>
        )}
      </div>

      {/* Image modal */}
      {showImageModal && (
        <div id="imageModal" style={{ display: 'flex' }}>
          <div className="modal-backdrop" onClick={closeImageModal}></div>
          <div className="modal-content">
            <button className="modal-close" style={{ background: 'none', border: 'none', padding: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333' }} onClick={closeImageModal}>
              <CloseIcon />
            </button>
            <img id="modalImage" src={modalImageSrc} alt="拡大画像" />
          </div>
        </div>
      )}

      {/* Settings modal */}
      {showSettings && (
        <div id="settingsModal">
          <div id="settingsBackdrop" style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.5)', zIndex: 9998 }} onClick={() => setShowSettings(false)} />
          <div id="settingsContent" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: 'white', padding: 20, borderRadius: 8, width: 300, zIndex: 9999, boxShadow: '0 4px 10px rgba(0,0,0,0.3)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
              <h2 style={{ margin: 0, fontSize: '1.2em' }}>設定</h2>
              <button id="closeSettings" style={{ background: 'none', border: 'none', padding: '2px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333' }} onClick={() => setShowSettings(false)}>
                <CloseIcon />
              </button>
            </div>
            <div style={{ marginBottom: 15 }}>
              <label><input type="checkbox" id="readToggle" checked={readToggle} onChange={e => setReadToggle(e.target.checked)} /> 既読を付ける</label>
            </div>
            <div style={{ marginBottom: 10 }}><label>回数: <input id="repeatCount" type="number" min={1} value={repeatCount} onChange={e => setRepeatCount(Number(e.target.value))} style={{ width: 60 }} /></label></div>
            <div style={{ marginBottom: 15 }}><label>文字列: <input id="repeatText" type="text" value={repeatText} onChange={e => setRepeatText(e.target.value)} style={{ width: '100%' }} /></label></div>
            <button id="startRepeat" style={{ width: '100%', padding: '6px 0', background: '#4CAF50', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }} onClick={startRepeat}>連投開始</button>
          </div>
        </div>
      )}
    </div>
  )
}
