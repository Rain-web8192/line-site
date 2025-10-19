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
    const savedSessionId = localStorage.getItem('sessionId')
    
    if (!agreed || version !== '1.0') {
      loadTerms()
      setShowTerms(true)
      setShowLoginModal(false)
      setIsLoggedIn(false)
    } else if (savedSessionId) {
      // セッションIDがある場合は自動的にログイン状態にする
      setSessionId(savedSessionId)
      setShowTerms(false)
      setShowLoginModal(false)
      autoLoginWithSession(savedSessionId)
    } else {
      setShowTerms(false)
      setShowLoginModal(true)
      setIsLoggedIn(false)
    }
  }, [loadTerms])

  useEffect(() => {
    // start polling
    if (pollingRef.current) clearInterval(pollingRef.current)
    pollingRef.current = setInterval(() => {
      if (isLoggedIn && sessionId && selectedChat) {
        const el = document.getElementById('rightPane')
        const autoScroll = el ? el.scrollHeight - el.scrollTop - el.clientHeight < 5 : true
        loadMessages(sessionId, selectedChat.squareChatMid, autoScroll)
      }
    }, 1000)
    return () => clearInterval(pollingRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, sessionId, selectedChat])

  async function callApi(body) {
    body.sessionId = sessionId

    const res = await fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    return data
  }

  async function autoLoginWithSession(sid) {
    try {
      const data = await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, action: 'squares' }),
      }).then(res => res.json())
      
      if (Array.isArray(data.result)) {
        setChats(data.result)
        setIsLoggedIn(true)
        setShowLoginModal(false)
        lastMessageIds.current.clear()
        setChatEvents([])
      } else {
        // セッション無効
        localStorage.removeItem('sessionId')
        setShowLoginModal(true)
        setIsLoggedIn(false)
      }
    } catch (err) {
      console.error('自動ログインエラー:', err)
      localStorage.removeItem('sessionId')
      setShowLoginModal(true)
      setIsLoggedIn(false)
    }
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
      })
      const result = await res.json()
      if (result.success && result.sessionId) {
        // セッションIDを保存してログイン状態に
        localStorage.setItem('sessionId', result.sessionId)
        setSessionId(result.sessionId)
        setIsLoggedIn(true)
        setShowLoginModal(false)
        setGeneratedPincode('')
        
        // チャットリストを取得
        const data = await fetch('/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: result.sessionId, action: 'squares' }),
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
      const response = await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, action: 'getProfile', pid, squareChatMid: selectedChat.squareChatMid }),
      })
      const result = await response.json()
      if (result.success && result.profile) {
        profileCache.current.set(pid, result.profile)
        return result.profile
      }
    } catch (e) {
      console.error('プロフィール取得エラー:', e)
    }
    return null
  }

  async function loadMessages(sid, chatMid, scrollToBottom = false) {
    if (!sid || !chatMid) return
    try {
      const data = await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, action: 'messages', squareChatMid: chatMid }),
      }).then(res => res.json())
      if (data.error) return
      if (!Array.isArray(data.events)) return

      const newEvents = []
      for (const e of data.events) {
        const msg = e.payload?.receiveMessage?.squareMessage?.message ?? e.payload?.sendMessage?.squareMessage?.message
        if (!msg) continue
        if (!lastMessageIds.current.has(msg.id)) {
          lastMessageIds.current.add(msg.id)
          // enrich
          const isReceive = e.type === 'RECEIVE_MESSAGE'
          let profile = data.profiles?.[msg.from]
          if (isReceive && !profile) profile = await getProfileIfNeeded(msg.from)
          newEvents.push({
            id: msg.id,
            isReceive,
            text: msg.text || '',
            deliveredTime: msg.deliveredTime,
            contentType: msg.contentType,
            messageRelationType: msg.messageRelationType,
            relatedMessageId: msg.relatedMessageId,
            profile,
            rawEvent: e,
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
      console.error('メッセージ取得中にエラーが発生しました', e)
    }
  }

  async function handleSelectChat(chat) {
    setSelectedChat(chat)
    setChatEvents([])
    lastMessageIds.current.clear()
    if (sessionId) {
      await loadMessages(sessionId, chat.squareChatMid, true)
    }
  }

  async function sendMessage() {
    const text = messageRef.current?.value.trim() || ''
    if (!text || !sessionId || !selectedChat) return alert('全て入力してください')
    try {
      if (replyingToId) {
        await replyToMessage(replyingToId, text)
        setReplyingToId(null)
        if (messageRef.current) messageRef.current.value = ''
        return
      }
      const data = await callApi({ action: 'send', squareChatMid: selectedChat.squareChatMid, text })
      if (data.message) {
        if (messageRef.current) messageRef.current.value = ''
        await loadMessages(sessionId, selectedChat.squareChatMid, true)
      } else if (data.error) alert(`エラー: ${data.message}`)
    } catch (e) {
      console.error('送信エラー:', e)
      alert('メッセージ送信に失敗しました')
    }
  }

  async function replyToMessage(relatedMessageId, text) {
    if (!sessionId || !selectedChat || !text) return alert('必要な情報が不足しています')
    try {
      const data = await callApi({ action: 'replyToMessage', squareChatMid: selectedChat.squareChatMid, text, relatedMessageId })
      if (data.message) {
        await loadMessages(sessionId, selectedChat.squareChatMid, true)
      } else if (data.error) alert(`エラー: ${data.message}`)
    } catch (e) {
      console.error('リプライ送信エラー:', e)
      alert('リプライメッセージ送信に失敗しました')
    }
  }

  async function startRepeat() {
    if (!repeatText.trim()) return alert('文字列を入力してください')
    if (repeatCount < 1) return alert('回数は1以上にしてください')
    try {
      const res = await fetch('/api/sends/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, sendcount: repeatCount, squareChatMid: selectedChat?.squareChatMid, text: repeatText, read: readToggle }),
      })
      if (!res.ok) throw new Error(`送信エラー: ${res.status}`)
      const data = await res.json()
      console.log('送信結果:', data)
      alert('連投送信が開始されました')
    } catch (err) {
      console.error(err)
      alert('送信に失敗しました')
    }
    setShowSettings(false)
  }

  function handleLogout() {
    localStorage.removeItem('sessionId')
    setSessionId('')
    setIsLoggedIn(false)
    setShowLoginModal(true)
    setChats([])
    setSelectedChat(null)
    setChatEvents([])
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
                console.error('同意処理エラー:', err)
                alert('同意処理中にエラーが発生しました')
              } finally {
                agreeButton.textContent = originalText
                agreeButton.disabled = false
              }
            }}>同意する</button>
          </div>
        </div>
      )}

      <div id="container" style={{ display: showTerms ? 'none' : 'flex', height: '100vh' }}>
        <div id="leftPane">
          {/* Login modal (kept visible as left pane content) */}
          <div id="loginModal" className="login-mode" style={{ display: showLoginModal ? 'flex' : 'none' }}>
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

          {/* Chat list area - only show when logged in */}
          {isLoggedIn && (
            <>
              <div style={{ padding: 12, borderBottom: '1px solid #ddd', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>チャット一覧</h3>
                <button onClick={handleLogout} style={{ padding: '6px 12px', background: '#ff4444', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>ログアウト</button>
              </div>
              <div id="chatButtons" style={{ padding: 12 }} tabIndex={0}>
                {chats.map((chat, idx) => (
                  <button key={idx} className={`chat-button ${selectedChat?.squareChatMid === (chat.squareChatMid || chat.chat?.squareChatMid) ? 'active' : ''}`} onClick={() => handleSelectChat(chat)}>
                    <div className="chat-button-content">
                      <div className="chat-icon-container">
                        { (chat.chat?.chatImageObsHash || chat.square?.profileImageObsHash) ? (
                          <img className="chat-icon" src={`https://obs.line-scdn.net/${chat.chat?.chatImageObsHash || chat.square?.profileImageObsHash}/preview`} alt="" onError={e => e.currentTarget.style.display = 'none'} />
                        ) : (
                          <div className="chat-icon-placeholder">📱</div>
                        ) }
                      </div>
                      <div className="chat-info">
                        <div className="chat-button-name">{chat.chat?.name || chat.name || 'Unknown'}</div>
                        <div className="chat-button-id">{((chat.chat?.squareChatMid || chat.squareChatMid) || '').slice(0,8)}...</div>
                      </div>
                      <div className="chat-member-count">({chat.squareStatus?.memberCount || 0}人)</div>
                    </div>
                    <div className="chat-button-indicator" />
                  </button>
                ))}
              </div>
              <div style={{ padding: 12 }}>
                <button id="loadMessages" disabled={!selectedChat} onClick={() => selectedChat && loadMessages(sessionId, selectedChat.squareChatMid, true)}>過去メッセージ取得</button>
                <span id="messageCount" style={{ marginLeft: 8 }}></span>
              </div>
            </>
          )}
        </div>

        {isLoggedIn && (
          <div id="rightPaneWrapper">
            <div id="chatHeader" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span id="chatTitle">{selectedChat ? (selectedChat.chat?.name || selectedChat.name) : '選択中のOpenChatは未選択です'}</span>
              <button id="settingsButton" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2em' }} title="設定" onClick={() => setShowSettings(true)}>⚙</button>
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
              <button id="cancelReply" style={{ background: 'none', border: 'none', fontSize: '1em', color: '#888', cursor: 'pointer' }} onClick={() => { setReplyingToId(null); document.getElementById('replyBox').style.display = 'none' }}>✕</button>
            </div>
          </div>

          <div id="sendArea">
            <label>メッセージ内容:
              <textarea id="message" ref={messageRef} placeholder="送信したい内容を入力"></textarea>
            </label>
            <button id="send" disabled={!selectedChat} onClick={sendMessage}>メッセージ送信</button>
          </div>
          </div>
        )}
      </div>

      {/* Image modal */}
      {showImageModal && (
        <div id="imageModal" style={{ display: 'flex' }}>
          <div className="modal-backdrop" onClick={closeImageModal}></div>
          <div className="modal-content">
            <button className="modal-close" onClick={closeImageModal}>×</button>
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
              <button id="closeSettings" style={{ background: 'none', border: 'none', fontSize: '1.2em', cursor: 'pointer' }} onClick={() => setShowSettings(false)}>✕</button>
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
