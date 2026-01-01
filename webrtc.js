let localStream = null;
let peerConnections = {}; // Map of peerId -> RTCPeerConnection
let canvases = {}; // Map of peerId -> canvas element
let signalingSocket = null;
let myClientId = null;
let myName = '';
let roomId = '';
let peers = {}; // Map of peerId -> {name: string, stream: MediaStream}
let chatEnabled = false;

const SIGNALING_SERVER = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}:${window.location.port}/ws`;

const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// Cookie helper functions
function setCookie(name, value, days = 365) {
    const date = new Date();
    date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
    const expires = "expires=" + date.toUTCString();
    document.cookie = name + "=" + encodeURIComponent(value) + ";" + expires + ";path=/";
}

function getCookie(name) {
    const nameEQ = name + "=";
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) === ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) === 0) {
            return decodeURIComponent(c.substring(nameEQ.length, c.length));
        }
    }
    return null;
}

function getUrlParameter(name) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(name);
}

function connectToSignalingServer() {
    myName = document.getElementById('userName').value.trim() || `User-${Date.now() % 10000}`;
    roomId = document.getElementById('roomId').value.trim();
    
    if (!roomId) {
        updateStatus('Please enter a Call ID', 'error');
        return;
    }
    
    // Store username and roomId in cookies
    setCookie('webrtc_username', myName);
    setCookie('webrtc_roomId', roomId);
    
    updateStatus('Connecting to signaling server...', 'status');
    
    try {
        signalingSocket = new WebSocket(SIGNALING_SERVER);
        
        signalingSocket.onopen = () => {
            updateStatus('Connected to signaling server', 'success');
            // Send initial message with peer name and room ID
            sendSignalingMessage({
                type: 'register',
                peerName: myName,
                roomId: roomId
            });
            document.getElementById('connectBtn').disabled = true;
            document.getElementById('disconnectBtn').disabled = false;
        };
        
        signalingSocket.onmessage = async (event) => {
            try {
                const message = JSON.parse(event.data);
                await handleSignalingMessage(message);
            } catch (error) {
                console.error('Error handling signaling message:', error);
                updateStatus(`Signaling error: ${error.message}`, 'error');
            }
        };
        
        signalingSocket.onerror = (error) => {
            console.error('WebSocket error:', error);
            updateStatus('Failed to connect to signaling server', 'error');
        };
        
        signalingSocket.onclose = () => {
            updateStatus('Disconnected from signaling server', 'error');
            document.getElementById('connectBtn').disabled = false;
            document.getElementById('disconnectBtn').disabled = true;
            document.getElementById('chatInput').disabled = true;
            document.getElementById('sendChatBtn').disabled = true;
            chatEnabled = false;
            signalingSocket = null;
            myClientId = null;
        };
    } catch (error) {
        updateStatus(`Connection error: ${error.message}`, 'error');
    }
}

function disconnectFromServer() {
    if (signalingSocket) {
        signalingSocket.close();
    }
    
    // Close all peer connections but keep local camera running
    Object.values(peerConnections).forEach(pc => pc.close());
    peerConnections = {};
    peers = {};
    
    updateVideoGrid();
}

async function handleSignalingMessage(message) {
    console.log('Received signaling message:', message.type);
    
    switch (message.type) {
        case 'welcome':
            myClientId = message.clientId;
            const peersInRoom = message.peersInRoom || (message.totalClients - 1);
            updateStatus(`Connected as "${myName}" (Client ${myClientId}) in room "${roomId}". Peers in room: ${peersInRoom}`, 'success');
            addLogMessage(`You are "${myName}" (Client ${myClientId}) in room "${roomId}"`);
            chatEnabled = true;
            document.getElementById('chatInput').disabled = false;
            document.getElementById('sendChatBtn').disabled = false;
            updateVideoGrid();
            break;
            
        case 'peer-connected':
            if (message.clientId !== myClientId) {
                const peerName = message.peerName || `Peer-${message.clientId}`;
                const peersInRoom = message.peersInRoom || message.totalClients;
                addLogMessage(`"${peerName}" (Client ${message.clientId}) joined room "${roomId}". Peers in room: ${peersInRoom}`);
                updateStatus(`"${peerName}" available in room. Ready to call.`, 'success');
                
                peers[message.clientId] = { name: peerName, stream: null };
                
                // If we have local stream and no existing connection, automatically call
                if (localStream && !peerConnections[message.clientId]) {
                    setTimeout(() => {
                        createAndSendOffer(message.clientId, peerName);
                    }, 1000);
                }
            }
            break;
            
        case 'peer-disconnected':
            addLogMessage(`Peer ${message.clientId} disconnected`);
            if (peers[message.clientId]) {
                updateStatus(`"${peers[message.clientId].name}" disconnected`, 'error');
                if (peerConnections[message.clientId]) {
                    peerConnections[message.clientId].close();
                    delete peerConnections[message.clientId];
                }
                delete peers[message.clientId];
                updateVideoGrid();
            }
            break;
            
        case 'offer':
            const peerName = message.peerName || `Peer-${message.senderId}`;
            peers[message.senderId] = { name: peerName, stream: null };
            addLogMessage(`Received offer from "${peerName}" (Client ${message.senderId})`);
            await handleOffer(message.offer, message.senderId, peerName);
            break;
            
        case 'answer':
            addLogMessage(`Received answer from "${peers[message.senderId]?.name || message.senderId}" (Client ${message.senderId})`);
            await handleAnswer(message.answer, message.senderId);
            break;
            
        case 'ice-candidate':
            if (message.candidate && peerConnections[message.senderId]) {
                await peerConnections[message.senderId].addIceCandidate(new RTCIceCandidate(message.candidate));
                console.log('Added ICE candidate from remote peer');
            }
            break;
            
        case 'chat':
            const senderName = message.senderName || `Client ${message.senderId}`;
            displayChatMessage(message.text, senderName, false, message.timestamp);
            break;
    }
}

function sendSignalingMessage(message) {
    if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
        signalingSocket.send(JSON.stringify(message));
    } else {
        console.error('Cannot send message: WebSocket not connected');
        updateStatus('Not connected to signaling server', 'error');
    }
}

function initVideoTexture(canvas, stream, canvasId) {
    let intervalID;
    const videoElement = document.createElement('video');
    videoElement.autoplay = true;
    videoElement.playsInline = true;
    videoElement.muted = (canvasId === 'local'); // Only mute local video
    videoElement.srcObject = stream;
    
    videoElement.addEventListener("canplaythrough", () => {
        videoElement.play().catch(err => { 
            console.error("Error playing video:", err); 
            updateStatus(`Error playing ${canvasId} video: ${err.message}`, 'error');
        });
        if (intervalID) clearInterval(intervalID);
        intervalID = setInterval(() => { 
            handleLoadedImage(canvas, videoElement, videoElement.videoWidth, videoElement.videoHeight); 
        }, 15);
    });
    
    videoElement.addEventListener("ended", () => { 
        if (intervalID) clearInterval(intervalID); 
    });
    
    // Store reference for cleanup
    canvas.videoElement = videoElement;
    canvas.intervalID = intervalID;
}

async function startLocalVideo() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        updateStatus("getUserMedia is not supported in this browser", 'error');
        return;
    }
    
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ 
            video: { width: 1280, height: 720 }, 
            audio: true 
        });
        
        updateVideoGrid();
        updateStatus("Local camera started. Waiting for peer...", 'success');
        addLogMessage('Local camera started');
    } catch (error) {
        updateStatus(`Failed to get local stream: ${error.message}`, 'error');
        console.error("Error accessing media devices:", error);
    }
}

async function createPeerConnection(peerId) {
    const pc = new RTCPeerConnection(configuration);
    
    // Add local stream tracks to peer connection
    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }
    
    // Handle incoming tracks
    pc.ontrack = (event) => {
        console.log('Received remote track from peer', peerId, ':', event.track.kind);
        
        if (peers[peerId]) {
            peers[peerId].stream = event.streams[0];
            updateVideoGrid();
            updateStatus("Remote stream received!", 'success');
        }
    };
    
    // Handle ICE candidates
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log('Sending ICE candidate to peer', peerId);
            sendSignalingMessage({
                type: 'ice-candidate',
                candidate: event.candidate,
                targetId: peerId,
                roomId: roomId
            });
        }
    };
    
    // Handle connection state changes
    pc.onconnectionstatechange = () => {
        updateStatus(`Connection state with ${peers[peerId]?.name || peerId}: ${pc.connectionState}`, 'status');
        console.log('Connection state:', pc.connectionState);
    };
    
    pc.oniceconnectionstatechange = () => {
        console.log('ICE connection state with', peerId, ':', pc.iceConnectionState);
    };
    
    peerConnections[peerId] = pc;
    return pc;
}

async function createAndSendOffer(targetId, peerName) {
    try {
        const pc = await createPeerConnection(targetId);
        
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        sendSignalingMessage({
            type: 'offer',
            offer: offer,
            targetId: targetId,
            peerName: myName,
            roomId: roomId
        });
        
        addLogMessage(`Sent offer to Client ${targetId}`);
        updateStatus(`Calling "${peerName}"...`, 'status');
    } catch (error) {
        updateStatus(`Error creating offer: ${error.message}`, 'error');
        console.error("Error creating offer:", error);
    }
}

async function handleAnswer(answer, senderId) {
    try {
        const pc = peerConnections[senderId];
        if (!pc) {
            console.error('No peer connection found for', senderId);
            return;
        }
        
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        updateStatus(`Connected to "${peers[senderId]?.name || senderId}"!`, 'success');
        addLogMessage(`Connection established with "${peers[senderId]?.name || senderId}"`);
    } catch (error) {
        updateStatus(`Error handling answer: ${error.message}`, 'error');
        console.error("Error handling answer:", error);
    }
}

async function handleOffer(offer, senderId, peerName) {
    try {
        if (!localStream) {
            updateStatus(`Received call from "${peerName}" but camera not started. Starting camera...`, 'status');
            await startLocalVideo();
        }
        
        const pc = await createPeerConnection(senderId);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        sendSignalingMessage({
            type: 'answer',
            answer: answer,
            targetId: senderId,
            peerName: myName,
            roomId: roomId
        });
        
        addLogMessage(`Answered call from "${peerName}"`);
        updateStatus(`Answering call from "${peerName}"...`, 'status');
    } catch (error) {
        updateStatus(`Error handling offer: ${error.message}`, 'error');
        console.error("Error handling offer:", error);
    }
}

function addLogMessage(message) {
    const logDiv = document.getElementById('signalingLog');
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = document.createElement('div');
    logEntry.textContent = `[${timestamp}] ${message}`;
    logDiv.appendChild(logEntry);
    logDiv.scrollTop = logDiv.scrollHeight;
}

function updateVideoGrid() {
    const grid = document.getElementById('videoGrid');
    if (!grid) {
        console.error('Video grid element not found');
        return;
    }
    
    console.log('Updating video grid, localStream:', !!localStream, 'peers:', Object.keys(peers).length);
    
    // Clear existing grid
    grid.innerHTML = '';
    
    // Clear old canvas intervals
    Object.values(canvases).forEach(canvas => {
        if (canvas && canvas.intervalID) {
            clearInterval(canvas.intervalID);
        }
    });
    canvases = {};
    
    // Collect all participants (self + peers)
    const participants = [];
    
    // Add self if we have a stream
    if (localStream) {
        participants.push({
            id: myClientId || 'local',
            name: myName ? `${myName} (You)` : 'You',
            stream: localStream,
            isSelf: true
        });
    }
    
    // Add all peers
    Object.entries(peers).forEach(([peerId, peer]) => {
        if (peer.stream) {
            participants.push({
                id: peerId,
                name: peer.name,
                stream: peer.stream,
                isSelf: false
            });
        }
    });
    
    // If no participants, show placeholder
    if (participants.length === 0) {
        grid.innerHTML = '<div class=\"video-slot solo\"><p style=\"text-align: center; padding: 50px;\">Waiting for camera...</p></div>';
        return;
    }
    
    // Create video slots for each participant
    participants.forEach((participant, index) => {
        const slot = document.createElement('div');
        slot.className = 'video-slot';
        
        // If only one participant (solo), make it full width
        if (participants.length === 1) {
            slot.classList.add('solo');
        }
        
        // Create canvas for video
        const canvas = document.createElement('canvas');
        canvas.className = 'gl.cubicinterpolation';
        canvas.width = 640;
        canvas.height = 480;
        canvas.id = `video-${participant.id}`;\n        
        // Create overlay with peer name
        const overlay = document.createElement('div');
        overlay.className = 'peer-overlay';
        overlay.textContent = participant.name;
        
        slot.appendChild(canvas);
        slot.appendChild(overlay);
        grid.appendChild(slot);
        
        // Initialize WebGL and video texture after canvas is in DOM
        setTimeout(() => {
            initCanvasGL(canvas);
            addMouseEvents(canvas);
            initVideoTexture(canvas, participant.stream, participant.isSelf ? 'local' : `remote-${participant.id}`);
        }, 0);
        
        canvases[participant.id] = canvas;
    });
}

function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    
    if (!text) return;
    
    if (!signalingSocket || signalingSocket.readyState !== WebSocket.OPEN) {
        updateStatus('Not connected to server. Cannot send message.', 'error');
        return;
    }
    
    const timestamp = new Date().toISOString();
    
    // Send to server
    sendSignalingMessage({
        type: 'chat',
        text: text,
        senderName: myName,
        roomId: roomId,
        timestamp: timestamp
    });
    
    // Display own message
    displayChatMessage(text, 'You', true, timestamp);
    
    // Clear input
    input.value = '';
}

function displayChatMessage(text, sender, isOwn, timestamp) {
    const messagesDiv = document.getElementById('chatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${isOwn ? 'own' : 'remote'}`;
    
    const senderDiv = document.createElement('div');
    senderDiv.className = 'sender';
    senderDiv.textContent = sender;
    
    const textDiv = document.createElement('div');
    textDiv.className = 'text';
    textDiv.textContent = text;
    
    const timeDiv = document.createElement('div');
    timeDiv.className = 'timestamp';
    const time = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
    timeDiv.textContent = time;
    
    messageDiv.appendChild(senderDiv);
    messageDiv.appendChild(textDiv);
    messageDiv.appendChild(timeDiv);
    
    messagesDiv.appendChild(messageDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function handleChatKeyPress(event) {
    if (event.key === 'Enter') {
        sendChatMessage();
    }
}

function updateStatus(message, type = 'status') {
    const statusDiv = document.getElementById('status');
    statusDiv.textContent = message;
    statusDiv.className = 'status ' + type;
}

function loadCredentialsFromCookies() {
    const savedUsername = getCookie('webrtc_username');
    const urlRoomId = getUrlParameter('roomid');
    const savedRoomId = getCookie('webrtc_roomId');
    
    if (savedUsername) {
        const userNameInput = document.getElementById('userName');
        if (userNameInput) {
            userNameInput.value = savedUsername;
        }
    }
    
    // Prioritize URL parameter over cookie for roomId
    const roomIdToUse = urlRoomId || savedRoomId;
    if (roomIdToUse) {
        const roomIdInput = document.getElementById('roomId');
        if (roomIdInput) {
            roomIdInput.value = roomIdToUse;
        }
    }
}

function webGLStart() {
    // Load saved credentials from cookies
    loadCredentialsFromCookies();
    
    // Automatically start local camera
    startLocalVideo();
    
    updateStatus("Ready. Connect to signaling server first.", 'status');
}

window.addEventListener('DOMContentLoaded', webGLStart);
