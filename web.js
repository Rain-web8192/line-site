const tokenInput = document.getElementById("token");  
const refreshTokenInput = document.getElementById("refreshtoken");  
const loginButton = document.getElementById("login");  
const chatButtons = document.getElementById("chatButtons");  
const messageInput = document.getElementById("message");  
const sendButton = document.getElementById("send");  
const loadMessagesButton = document.getElementById("loadMessages");  
const result = document.getElementById("rightPane");  
const settingsButton = document.getElementById('settingsButton');
const settingsModal = document.getElementById('settingsModal');
const settingsBackdrop = document.getElementById('settingsBackdrop');
const closeSettings = document.getElementById('closeSettings');
let selectedChatMid = null;  
let lastMessageIds = new Set();  
let replyingToId = null;  

settingsButton.addEventListener('click', () => {
  settingsModal.style.display = 'block';
});

closeSettings.addEventListener('click', () => {
  settingsModal.style.display = 'none';
});

settingsBackdrop.addEventListener('click', () => {
  settingsModal.style.display = 'none';
});
  
// ランダムな6桁の数字を生成  
function generateRandomPincode() {  
	return Math.floor(100000 + Math.random() * 900000).toString();  
}  
  
// deliveredTimeを時:分形式に変換  
function formatDeliveredTime(deliveredTime) {  
	if (!deliveredTime) return "";  
	const date = new Date(Number(deliveredTime));  
	const hours = String(date.getHours()).padStart(2, '0');  
	const minutes = String(date.getMinutes()).padStart(2, '0');  
	return `${hours}:${minutes}`;  
}  

// 利用規約モーダルの表示/非表示制御  
function showTermsModal() {  
  document.getElementById('termsModal').style.display = 'flex';  
  document.getElementById('loginModal').style.display = 'none';  
  document.getElementById('container').style.display = 'none';  
}  
  
function hideTermsModal() {  
  document.getElementById('termsModal').style.display = 'none';  
} 
  
// 利用規約の読み込み  
async function loadTerms() {  
  try {  
    const response = await fetch('/terms.txt');  
    const termsText = await response.text();  
    document.getElementById('termsContent').textContent = termsText;  
  } catch (error) {  
    console.error('利用規約の読み込みに失敗しました:', error);  
    document.getElementById('termsContent').textContent = '利用規約の読み込みに失敗しました。';  
  }  
}  
  
// 同意ボタンの状態管理  
function updateAgreeButtonState() {  
  const ageCheck = document.getElementById('ageCheck').checked;  
  const termsCheck = document.getElementById('termsCheck').checked;  
  const agreeButton = document.getElementById('agreeButton');  
    
  agreeButton.disabled = !(ageCheck && termsCheck);  
}  
  
// 利用規約同意処理  
document.getElementById('agreeButton').onclick = async () => {  
  const ageCheck = document.getElementById('ageCheck').checked;  
  const termsCheck = document.getElementById('termsCheck').checked;  
    
  if (!ageCheck || !termsCheck) {  
    alert('すべての項目に同意しないとこのサービスは使えません。');  
    return;  
  }  
    
  // ローディング状態を表示  
  const agreeButton = document.getElementById('agreeButton');  
  const originalText = agreeButton.textContent;  
  agreeButton.disabled = true;  
    
  try {  
      
    agreeButton.textContent = '同意処理中...';  
      
    // 同意情報をサーバーに送信
    const response = await fetch('/api/terms-agreement', {  
      method: 'POST',  
      headers: { 'Content-Type': 'application/json' },  
      body: JSON.stringify({  
        ageConfirmed: ageCheck,  
        termsAgreed: termsCheck,  
        userAgent: navigator.userAgent,  
      })  
    });  
      
    const result = await response.json();  
      
    if (result.success) {  
      // 利用規約同意完了、ログインモーダルを表示  
      hideTermsModal();  
      showLoginModal();  
        
      // 同意済みフラグをローカルストレージに保存  
      localStorage.setItem('termsAgreed', 'true');  
      localStorage.setItem('termsVersion', '1.0');  
    } else {  
      alert('同意処理に失敗しました');  
    }  
  } catch (error) {  
    console.error('同意処理エラー:', error);  
    alert('同意処理中にエラーが発生しました');  
  } finally {  
    // ローディング状態をリセット  
    agreeButton.textContent = originalText;  
    agreeButton.disabled = false;  
  }  
};
  
// チェックボックスの変更監視  
document.getElementById('ageCheck').addEventListener('change', updateAgreeButtonState);  
document.getElementById('termsCheck').addEventListener('change', updateAgreeButtonState);

  
// ログインモーダルの表示/非表示制御  
function showLoginModal() {  
	document.getElementById('loginModal').style.display = 'flex';  
	document.getElementById('container').style.display = 'none';  
}  
  
function hideLoginModal() {  
	document.getElementById('loginModal').style.display = 'none';  
	document.getElementById('container').style.display = 'flex';  
}  
  
// モバイルデバイス検出  
function isMobileDevice() {  
	return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);  
}  
  
// 戻るボタン機能  
function goBackToList() {  
	document.body.classList.remove('chat-selected');  
	selectedChatMid = null;  
	sendButton.disabled = true;  
	loadMessagesButton.disabled = true;  
	result.textContent = "";  
	document.getElementById("chatHeader").textContent = "選択中のOpenChatは未選択です";  
}  
  
// チャットボタンを作成する共通関数  
function createChatButton(chat, token) {  
	const btn = document.createElement("button");  
	btn.className = "chat-button";  
	  
	const chatImageHash = chat.chat?.chatImageObsHash || chat.square?.profileImageObsHash;  
	const memberCount = chat.squareStatus?.memberCount || 0;  
	const chatName = chat.chat?.name || chat.name || 'Unknown';  
	  
	btn.innerHTML = `  
		<div class="chat-button-content">  
			<div class="chat-icon-container">  
				${chatImageHash ?   
					`<img class="chat-icon" src="https://obs.line-scdn.net/${chatImageHash}/preview"   
						 onerror="this.style.display='none'" alt="チャットアイコン">` :   
					'<div class="chat-icon-placeholder">📱</div>'  
				}  
			</div>  
			<div class="chat-info">  
				<div class="chat-button-name">${chatName}</div>  
				<div class="chat-button-id">${(chat.chat?.squareChatMid || chat.squareChatMid)?.slice(0, 8)}...</div>  
			</div>  
			<div class="chat-member-count">(${memberCount}人)</div>  
		</div>  
		<div class="chat-button-indicator"></div>  
	`;  
	  
btn.onclick = async () => {    
	if (isMobileDevice()) {    
		document.body.classList.add('chat-selected');    
		const chatHeader = document.getElementById("chatHeader");    
		chatHeader.innerHTML = `    
			<button class="back-button" onclick="goBackToList()">＜</button>    
			<span>${chatName}</span>     
      <button id="settingsButton" > ☉ </button>
		`;    
	} else {    
		document.getElementById("chatHeader").textContent = chatName;    
	}    
		  
		selectedChatMid = chat.squareChatMid;  
		sendButton.disabled = false;  
		loadMessagesButton.disabled = false;  
		result.textContent = `選択中: ${chatName}\n\n過去メッセージを取得中...`;  
		lastMessageIds.clear();  
		await loadMessages(token, selectedChatMid, true);  
	};  
	  
	return btn;  
}  
  
// モーダル用のログイン処理  
document.getElementById("modalLogin").onclick = async () => {  
	const token = document.getElementById("modalToken").value.trim();  
	const refreshToken = document.getElementById("modalRefreshToken").value.trim();  
	  
	if (!token) {  
		alert("AuthTokenを入力してください");  
		return;  
	}   
	  
	document.getElementById("token").value = token;  
	document.getElementById("refreshtoken").value = refreshToken;  
	  
	try {  
		const data = await callApi({ token, action: "squares"});  
		  
		if (Array.isArray(data.result)) {  
			hideLoginModal();  
			chatButtons.innerHTML = "";  
			selectedChatMid = null;  
			sendButton.disabled = true;  
			loadMessagesButton.disabled = true;  
			result.textContent = "";  
			  
			for (const chat of data.result) {  
				chatButtons.appendChild(createChatButton(chat, token));  
			}  
		}  
	} catch (error) {  
		console.error("ログインエラー:", error);  
		alert("ログインに失敗しました");  
	}  
};  
  
// パスワードログイン処理の共通関数  
async function handlePasswordLogin(email, password, resultDiv, isModal = false) {  
	if (!email || !password) {  
		resultDiv.innerHTML = '<div style="color: #e74c3c;">メールアドレスとパスワードを入力してください</div>';  
		return;  
	}  
	  
	const pincode = generateRandomPincode();  
	const pincodeElement = document.getElementById(isModal ? 'modalGeneratedPincode' : 'generatedPincode');  
	const displayElement = document.getElementById(isModal ? 'modalPincodeDisplay' : 'passwordPincodeDisplay');  
	  
	pincodeElement.textContent = pincode;  
	displayElement.style.display = 'block';  
	  
	try {  
		resultDiv.innerHTML = '<div style="color: #3498db;">ログイン中...</div>';  
		  
		const response = await fetch("/api/login/password", {  
			method: "POST",  
			headers: { "Content-Type": "application/json" },  
			body: JSON.stringify({ email, password, pincode })  
		});  
		  
		const result = await response.json();  
		  
		if (result.success) {  
			resultDiv.innerHTML = '<div style="color: #27ae60;">ログイン成功！</div>';  
			const currentUrl = new URL(window.location.href);  
			currentUrl.searchParams.set('token', result.authToken);  
			if (result.refreshToken) {  
				currentUrl.searchParams.set('refreshToken', result.refreshToken);  
			}  
			  
			setTimeout(() => {  
				window.location.href = currentUrl.toString();  
			}, 1000);  
		} else {  
			resultDiv.innerHTML = `<div style="color: #e74c3c;">ログインに失敗しました: ${result.error}</div>`;  
		}  
	} catch (error) {  
		resultDiv.innerHTML = `<div style="color: #e74c3c;">エラーが発生しました: ${error.message}</div>`;  
	}  
}  
  
// モーダル用のパスワードログイン処理  
document.getElementById("modalPasswordLogin").onclick = async () => {  
	const email = document.getElementById("modalEmail").value;  
	const password = document.getElementById("modalPassword").value;  
	const resultDiv = document.getElementById("modalResult");  
	  
	await handlePasswordLogin(email, password, resultDiv, true);  
};  
  
// パスワードログイン（既存）  
document.getElementById("passwordLogin").onclick = async () => {  
	const email = document.getElementById("email").value;  
	const password = document.getElementById("password").value;  
	const resultDiv = document.getElementById("passwordResult");  
	  
	await handlePasswordLogin(email, password, resultDiv, false);  
};  
  
// Enterキーでログイン  
document.getElementById("password").addEventListener("keypress", function(event) {  
	if (event.key === "Enter") {  
		document.getElementById("passwordLogin").click();  
	}  
});  
  
// 汎用API呼び出し  
async function callApi(body) {  
	const refreshToken = refreshTokenInput.value.trim();  
	  
	let url = "/";  
	if (refreshToken) {  
		url += `?refreshToken=${encodeURIComponent(refreshToken)}`;  
		body.refreshToken = refreshToken;  
	}  
	  
	const res = await fetch(url, {  
		method: "POST",  
		headers: { "Content-Type": "application/json" },  
		body: JSON.stringify(body),  
	});  
	const data = await res.json();  
	  
	if (data.updatedAuthToken) {  
		tokenInput.value = data.updatedAuthToken;  
	}  
	if (data.updatedRefreshToken) {  
		refreshTokenInput.value = data.updatedRefreshToken;  
	}  
	  
	if (data.tokenChanged) {  
		console.log("トークンが更新されました");  
	}  
	  
	return data;  
}  
  
loginButton.onclick = async () => {  
	const token = tokenInput.value.trim();  
	if (!token) return alert("AuthTokenを入力してください");  
	  
	try {  
		const data = await callApi({ token, action: "squares" });  
		  
		chatButtons.innerHTML = "";  
		selectedChatMid = null;  
		sendButton.disabled = true;  
		loadMessagesButton.disabled = true;  
		result.textContent = "";  
		  
		if (Array.isArray(data.result)) {  
			hideLoginModal();  
			for (const chat of data.result) {  
				const btn = document.createElement("button");  
				btn.className = "chat-button";  
				btn.textContent = `${chat.name} (${chat.squareChatMid.slice(0, 6)}...)`;  
				btn.onclick = async () => {    
					if (isMobileDevice()) {    
						document.body.classList.add('chat-selected');    
						const chatHeader = document.getElementById("chatHeader");    
						chatHeader.innerHTML = `    
							<button class="back-button" onclick="goBackToList()">＜</button>    
							<span>${chat.name}</span>      
              <button id="settingsButton" > ☉ </button>
						`;       
					} else {    
						document.getElementById("chatHeader").textContent = chat.name;    
					}
					selectedChatMid = chat.squareChatMid;  
					sendButton.disabled = false;  
					loadMessagesButton.disabled = false;  
					result.textContent = `選択中: ${chat.name}\n\n過去メッセージを取得中...`;  
					lastMessageIds.clear();  
					await loadMessages(tokenInput.value.trim(), selectedChatMid, true);  
				};  
				chatButtons.appendChild(btn);  
			}  
		} else {  
			result.textContent = JSON.stringify(data.result, null, 2);  
		}  
	} catch (error) {  
		console.error("ログインエラー:", error);  
		alert("ログインに失敗しました");  
	}  
};  

// 連投開始ボタン → /api/sends/ 呼び出し
document.getElementById('startRepeat').addEventListener('click', async () => {
  const count = parseInt(document.getElementById('repeatCount').value, 10);
  const text = document.getElementById('repeatText').value;
  const readOn = document.getElementById('readToggle').checked;

  if (!text.trim()) {
    alert('文字列を入力してください');
    return;
  }
  if (count < 1) {
    alert('回数は1以上にしてください');
    return;
  }

  try {
    const res = await fetch('/api/sends/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sendcount: count,
        squareChatMid: selectedChatMid,
        text: text,
        read: readOn
      })
    });

    if (!res.ok) throw new Error(`送信エラー: ${res.status}`);
    const data = await res.json();
    console.log('送信結果:', data);
    alert('連投送信が開始されました');
  } catch (err) {
    console.error(err);
    alert('送信に失敗しました');
  }

  settingsModal.style.display = 'none';
});
  
// プロフィールキャッシュ  
const profileCache = new Map();  
  
async function getProfileIfNeeded(pid) {  
	if (profileCache.has(pid)) {  
		return profileCache.get(pid);  
	}  
	  
	try {  
		const response = await fetch('/api/profile', {  
			method: 'POST',  
			headers: { 'Content-Type': 'application/json' },  
			body: JSON.stringify({  
				token: tokenInput.value.trim(),  
				pid: pid  
			})  
		});  
		  
		const profile = await response.json();  
		if (profile.success) {  
			profileCache.set(pid, profile.data);  
			return profile.data;  
		}  
	} catch (error) {  
		console.error('プロフィール取得エラー:', error);  
	}  
	  
	return null;  
}  
  
async function replyToMessage(relatedMessageId, text) {  
	const token = tokenInput.value.trim();  
	if (!token || !selectedChatMid || !text) {  
		alert("必要な情報が不足しています");  
		return;  
	}  
	  
	try {  
		const data = await callApi({  
			token,  
			action: "replyToMessage",  
			squareChatMid: selectedChatMid,  
			text,  
			relatedMessageId  
		});  
		  
		if (data.message) {  
			console.log("リプライ送信成功:", data.message);  
			await loadMessages(token, selectedChatMid, true);  
		} else if (data.error) {  
			alert(`エラー: ${data.message}`);  
		}  
	} catch (error) {  
		console.error("リプライ送信エラー:", error);  
		alert("リプライメッセージ送信に失敗しました");  
	}  
}  
  
sendButton.onclick = async () => {  
	const token = tokenInput.value.trim();  
	const text = messageInput.value.trim();  
	if (!token || !selectedChatMid || !text) return alert("全て入力してください");  
	  
	try {  
		if (replyingToId) {  
			await replyToMessage(replyingToId, text);  
			replyingToId = null;  
			document.getElementById("replyBox").style.display = "none";  
			messageInput.value = "";  
			return;  
		}  
		  
		const data = await callApi({  
			token,  
			action: "send",  
			squareChatMid: selectedChatMid,  
			text,  
		});  
		  
		if (data.message) {  
			messageInput.value = "";  
			await loadMessages(token, selectedChatMid, true);  
		} else if (data.error) {  
			alert(`エラー: ${data.message}`);  
		}  
	} catch (error) {  
		console.error("送信エラー:", error);  
		alert("メッセージ送信に失敗しました");  
	}  
};  
  
async function loadMessages(token, chatMid, scrollToBottom = false) {  
	if (!token || !chatMid) return;  
	  
	try {  
		const data = await callApi({ token, action: "messages", squareChatMid: chatMid });  
		  
		if (data.error) {  
			result.textContent = `エラー: ${data.message}`;  
			return;  
		}  
		  
		if (!Array.isArray(data.events)) {  
			result.textContent = "データが正しくありません";  
			console.error("Unexpected response format:", data);  
			return;  
		}  
		  
		let newEvents = data.events.filter(e => {  
			const msg = e.payload?.receiveMessage?.squareMessage?.message  
				?? e.payload?.sendMessage?.squareMessage?.message;  
			if (!msg) return false;  
			return !lastMessageIds.has(msg.id);  
		});  
		  
		if (newEvents.length === 0 && !scrollToBottom) {  
			return;  
		}  
    
		// 新着メッセージのIDをセットに追加  
		for (const e of newEvents) {  
			const msg = e.payload?.receiveMessage?.squareMessage?.message  
				?? e.payload?.sendMessage?.squareMessage?.message;  
			if (msg?.id) lastMessageIds.add(msg.id);  
		}  
  
		if (!document.getElementById("chatContent")) {  
			result.innerHTML = '<div id="chatContent" style="display:flex; flex-direction:column; gap:6px;"></div>';  
		}  
		const chatContent = document.getElementById("chatContent");  
  
		for (const e of newEvents) {  
			const isReceive = e.type === "RECEIVE_MESSAGE";  
			const isSend = e.type === "SEND_MESSAGE";  
  
			const msgData = e.payload?.receiveMessage?.squareMessage?.message  
						 ?? e.payload?.sendMessage?.squareMessage?.message;  
			if (!msgData) continue;  
  
			const from = msgData.from || msgData._from || "?";  
			const text = msgData.text?.trim() || "";  
			const id = msgData.id;  
			const deliveredTime = msgData.deliveredTime;  
			const contentType = msgData.contentType;  
  
			// プロフィール情報の動的取得  
			let profile = data.profiles?.[from];  
			let displayName = from;  
			let pictureStatus = null;  
  
			if (isReceive) {  
				if (!profile) {  
					profile = await getProfileIfNeeded(from);  
				}  
  
				if (profile) {  
					displayName = profile.displayName || from;  
					pictureStatus = profile.pictureStatus;  
				}  
			}  
  
			const wrapper = document.createElement("div");  
			wrapper.className = "message-wrapper";  
			wrapper.style.display = "flex";  
			wrapper.style.flexDirection = "column";  
			wrapper.style.alignItems = isSend ? "flex-end" : "flex-start";  
			wrapper.style.gap = "2px";  
  
			// プロフィール表示（受信時のみ）  
			if (profile && isReceive) {  
				const headerDiv = document.createElement("div");  
				headerDiv.className = "profile-header";  
				headerDiv.style.display = "flex";  
				headerDiv.style.alignItems = "center";  
				headerDiv.style.gap = "6px";  
  
				if (pictureStatus) {  
					const iconImg = document.createElement("img");  
					iconImg.src = `https://obs.line-scdn.net/${pictureStatus}/preview`;  
					iconImg.className = "profile-icon";  
					iconImg.onerror = () => { iconImg.style.display = "none"; };  
					headerDiv.appendChild(iconImg);  
				}  
  
				const nameSpan = document.createElement("span");  
				nameSpan.textContent = displayName;  
				headerDiv.appendChild(nameSpan);  
  
				wrapper.appendChild(headerDiv);  
			}  
  
			const msgDiv = document.createElement("div");  
			msgDiv.className = `message ${isSend ? "right" : "left"}`;  
			msgDiv.dataset.messageId = id;  
			msgDiv.style.display = "flex";  
			msgDiv.style.flexDirection = "column";  
			msgDiv.style.alignItems = "flex-start";  
			msgDiv.style.gap = "4px";  
  
			msgDiv.onclick = () => {  
				replyingToId = id;  
				document.getElementById("replyBox").style.display = "block";  
				document.getElementById("replyPreviewText").textContent = (text || "画像").slice(0, 30) + ((text.length > 30) ? "..." : "");  
			};  
  
			if (msgData.messageRelationType === "REPLY" && msgData.relatedMessageId) {  
				const replyMsgElem = document.querySelector(`[data-message-id="${msgData.relatedMessageId}"]`);  
				if (replyMsgElem) {  
					const replyPreview = document.createElement("div");  
					replyPreview.className = "reply-preview";  
					replyPreview.style.alignSelf = "stretch";  
					const replyTextNode = [...replyMsgElem.childNodes].find(n => n.nodeType === Node.ELEMENT_NODE && n.textContent);  
					replyPreview.textContent = replyTextNode?.textContent?.slice(0, 30) + (replyTextNode?.textContent?.length > 30 ? "..." : "");  
					replyPreview.onclick = () => {  
						replyMsgElem.scrollIntoView({ behavior: "smooth", block: "center" });  
					};  
					msgDiv.appendChild(replyPreview);  
				}  
			}  
  
			// テキストメッセージまたはメディアメッセージの処理  
			if (text || contentType === 0) {  
				const textNode = document.createElement("div");  
				textNode.textContent = text || "その他";  
				textNode.style.alignSelf = "stretch";  
				msgDiv.appendChild(textNode);  
			} else if (e.isImage && e.imageData) {  
				const contentTypeStr = msgData.contentType;  
  
				if (contentTypeStr === "VIDEO" || contentTypeStr === 2) {  
					const videoElement = document.createElement("video");  
					videoElement.src = e.imageData;  
					videoElement.controls = true;  
					videoElement.className = "media-content video";  
  
					videoElement.onerror = () => {  
						videoElement.style.display = "none";  
						const errorText = document.createElement("div");  
						errorText.textContent = "動画を読み込めませんでした";  
						errorText.style.color = "#666";  
						errorText.style.fontSize = "0.9em";  
						msgDiv.appendChild(errorText);  
					};  
  
					msgDiv.appendChild(videoElement);  
				} else {  
					const imgElement = document.createElement("img");  
					imgElement.src = e.imageData;  
					imgElement.className = "media-content";  
  
					imgElement.onclick = (event) => {  
						event.stopPropagation();  
						showImageModal(e.imageData);  
					};  
  
					imgElement.onerror = () => {  
						imgElement.style.display = "none";  
						const errorText = document.createElement("div");  
						errorText.textContent = "画像を読み込めませんでした";  
						errorText.style.color = "#666";  
						errorText.style.fontSize = "0.9em";  
						msgDiv.appendChild(errorText);  
					};  
  
					msgDiv.appendChild(imgElement);  
				}  
			}  
  
			wrapper.appendChild(msgDiv);  
  
			// 吹き出しの外に時間表示  
			if (deliveredTime) {  
				const timeDiv = document.createElement("div");  
				timeDiv.className = "message-time";  
				timeDiv.style.fontSize = "0.75em";  
				timeDiv.style.color = "#666";  
				timeDiv.style.marginTop = "2px";  
				timeDiv.textContent = formatDeliveredTime(deliveredTime);  
				wrapper.appendChild(timeDiv);  
			}  
  
			chatContent.appendChild(wrapper);  
		}  
  
		if (scrollToBottom) {  
			chatContent.lastElementChild?.scrollIntoView({ behavior: "smooth" });  
		}  
	} catch (e) {  
		result.textContent = "メッセージ取得中にエラーが発生しました";  
		console.error(e);  
	}  
}  
  
loadMessagesButton.onclick = async () => {  
	if (!selectedChatMid) return alert("チャットを選択してください");  
	await loadMessages(tokenInput.value.trim(), selectedChatMid, true);  
};  
  
document.getElementById("cancelReply").onclick = () => {  
	replyingToId = null;  
	document.getElementById("replyBox").style.display = "none";  
};  
  
// モーダル表示関数  
function showImageModal(imageSrc) {  
	const modal = document.getElementById('imageModal');  
	const modalImage = document.getElementById('modalImage');  
	modalImage.src = imageSrc;  
	modal.style.display = 'flex';  
}  
  
// モーダル閉じる関数  
function closeImageModal() {  
	const modal = document.getElementById('imageModal');  
	modal.style.display = 'none';  
}  
  
// ESCキーでモーダルを閉じる  
document.addEventListener('keydown', (event) => {  
	if (event.key === 'Escape') {  
		closeImageModal();  
	}  
});  
  
window.addEventListener("DOMContentLoaded", async () => {  
  if (isMobileDevice()) {  
    document.body.classList.add('mobile-device');  
  }  
    
  // 利用規約同意確認  
  const termsAgreed = localStorage.getItem('termsAgreed');  
  const termsVersion = localStorage.getItem('termsVersion');  
    
  if (!termsAgreed || termsVersion !== '1.0') {  
    // 利用規約未同意または古いバージョン  
    await loadTerms();  
    showTermsModal();  
    return;  
  }  
    
  // 既存のトークン処理  
  const urlParams = new URLSearchParams(window.location.search);  
  const tokenFromUrl = urlParams.get("token");  
  const refreshTokenFromUrl = urlParams.get("refreshToken") || urlParams.get("refresh_token");  
    
  if (tokenFromUrl) {  
    document.getElementById("modalToken").value = tokenFromUrl;  
    document.getElementById("token").value = tokenFromUrl;  
  }  
  if (refreshTokenFromUrl) {  
    document.getElementById("modalRefreshToken").value = refreshTokenFromUrl;  
    document.getElementById("refreshtoken").value = refreshTokenFromUrl;  
  }  
    
  if (tokenFromUrl) {  
    document.getElementById("modalLogin").click();  
  } else {  
    showLoginModal();  
  }  
}); 
  
let pollingInterval = null;  
  
function isScrolledToBottom() {  
	const el = document.getElementById("rightPane");  
	return el.scrollHeight - el.scrollTop - el.clientHeight < 5;  
}  
  
// ポーリング開始  
function startPolling() {  
	if (pollingInterval) clearInterval(pollingInterval);  
	pollingInterval = setInterval(() => {  
		const token = tokenInput.value.trim();  
		if (token && selectedChatMid) {  
			const autoScroll = isScrolledToBottom();  
			loadMessages(token, selectedChatMid, autoScroll);  
		}  
	}, 1000);  
}  
  
startPolling();
