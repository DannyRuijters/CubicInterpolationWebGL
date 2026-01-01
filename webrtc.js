let localStream = null;
let peerConnections = {}; // Track peer connections by peer ID
let canvases = {}; // Track canvases by id: { local: {canvas, container}, remote-{peerId}: {canvas, container} }
let signalingSocket = null;
let myClientId = null;
let myName = '';
let roomId = '';
let remotePeers = {}; // Track remote peers: { peerId: { name: 'name', ... } }
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

function createVideoCanvas(canvasId, title, peerInfo) {
    const videoGrid = document.getElementById('videoGrid');
    
    // Create container div
    const container = document.createElement('div');
    container.className = 'video-box';
    container.id = `${canvasId}-container`;
    
    // Create title
    const h3 = document.createElement('h3');
    h3.textContent = title;
    container.appendChild(h3);
    
    // Create peer info div
    const peerInfoDiv = document.createElement('div');
    peerInfoDiv.className = 'peer-info';
    peerInfoDiv.id = `${canvasId}PeerInfo`;
    peerInfoDiv.textContent = peerInfo;
    container.appendChild(peerInfoDiv);
    
    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.id = canvasId;
    canvas.className = 'gl.cubicinterpolation';
    canvas.width = 640;
    canvas.height = 640;
    container.appendChild(canvas);
    
    // Add to grid
    videoGrid.appendChild(container);
    
    // // Add mouse events for the new canvas
    // addMouseEvents(canvas);
    
    // Rebalance grid layout
    rebalanceVideoGrid();
    
    return { canvas, container };
}

function removeVideoCanvas(canvasId) {
    const canvasData = canvases[canvasId];
    if (canvasData) {
        // Clear interval if exists
        if (canvasData.canvas.intervalID) {
            clearInterval(canvasData.canvas.intervalID);
        }
        // Remove from DOM
        if (canvasData.container && canvasData.container.parentNode) {
            canvasData.container.parentNode.removeChild(canvasData.container);
        }
        // Remove from tracking
        delete canvases[canvasId];
        // Rebalance grid
        rebalanceVideoGrid();
    }
}

function rebalanceVideoGrid() {
    const videoGrid = document.getElementById('videoGrid');
    const numCanvases = Object.keys(canvases).length;
    
    if (numCanvases === 0) {
        return;
    }
    
    // Calculate maximum size based on viewport
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const maxCanvasWidth = Math.floor((viewportWidth - 100) / numCanvases); // Account for padding/margins
    const maxCanvasHeight = viewportHeight - 300; // Account for controls and other UI
    const maxSize = Math.min(maxCanvasWidth, maxCanvasHeight);
    
    // Set all canvases to exactly the same size
    Object.keys(canvases).forEach(canvasId => {
        const container = canvases[canvasId].container;
        const canvas = canvases[canvasId].canvas;
        // Set equal flex basis for all containers
        container.style.flex = `0 0 ${maxSize + 50}px`;
        container.style.width = `${maxSize + 50}px`;
        container.style.minWidth = `${maxSize + 50}px`;
        container.style.maxWidth = `${maxSize + 50}px`;
        // Force canvas to be exactly the same size
        canvas.style.width = `${maxSize}px`;
        canvas.style.height = `${maxSize}px`;
        canvas.style.minWidth = `${maxSize}px`;
        canvas.style.maxWidth = `${maxSize}px`;
        canvas.style.minHeight = `${maxSize}px`;
        canvas.style.maxHeight = `${maxSize}px`;
    });
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
    
    // Close all peer connections
    Object.keys(peerConnections).forEach(peerId => {
        if (peerConnections[peerId]) {
            peerConnections[peerId].close();
        }
    });
    peerConnections = {};
    
    // Remove all remote canvases
    Object.keys(canvases).forEach(canvasId => {
        if (canvasId.startsWith('remote-')) {
            removeVideoCanvas(canvasId);
        }
    });
    
    remotePeers = {};
    
    updateStatus("Disconnected from server (local video still active)", 'status');
    addLogMessage('Disconnected from server');
}

async function handleSignalingMessage(message) {
    console.log('Received signaling message:', message.type);
    
    switch (message.type) {
        case 'welcome':
            myClientId = message.clientId;
            const peersInRoom = message.peersInRoom || (message.totalClients - 1);
            updateStatus(`Connected as "${myName}" (Client ${myClientId}) in room "${roomId}". Peers in room: ${peersInRoom}`, 'success');
            addLogMessage(`You are "${myName}" (Client ${myClientId}) in room "${roomId}"`);
            // Update local peer info if canvas exists
            const localPeerInfo = document.getElementById('localVideoPeerInfo');
            if (localPeerInfo) {
                localPeerInfo.textContent = `${myName} (ID: ${myClientId}) - Room: ${roomId}`;
            }
            chatEnabled = true;
            document.getElementById('chatInput').disabled = false;
            document.getElementById('sendChatBtn').disabled = false;
            break;
            
        case 'peer-connected':
            if (message.clientId !== myClientId) {
                const peerName = message.peerName || `Peer-${message.clientId}`;
                const peerId = message.clientId;
                const peersInRoom = message.peersInRoom || message.totalClients;
                
                // Track the new peer
                remotePeers[peerId] = { name: peerName };
                
                addLogMessage(`"${peerName}" (Client ${peerId}) joined room "${roomId}". Peers in room: ${peersInRoom}`);
                updateStatus(`"${peerName}" joined. Total peers: ${Object.keys(remotePeers).length}`, 'success');
                
                // If we have local stream and no existing connection to this peer, automatically call
                if (localStream && !peerConnections[peerId]) {
                    setTimeout(() => {
                        createAndSendOffer(peerId, peerName);
                    }, 1000);
                }
            }
            break;
            
        case 'peer-disconnected':
            const disconnectedPeerId = message.clientId;
            addLogMessage(`Peer ${disconnectedPeerId} disconnected`);
            
            if (remotePeers[disconnectedPeerId]) {
                const peerName = remotePeers[disconnectedPeerId].name;
                updateStatus(`"${peerName}" disconnected`, 'error');
                
                // Remove remote canvas for this peer
                removeVideoCanvas(`remote-${disconnectedPeerId}`);
                
                // Close peer connection
                if (peerConnections[disconnectedPeerId]) {
                    peerConnections[disconnectedPeerId].close();
                    delete peerConnections[disconnectedPeerId];
                }
                
                // Remove from tracking
                delete remotePeers[disconnectedPeerId];
            }
            break;
            
        case 'offer':
            const senderIdOffer = message.senderId;
            const peerNameOffer = message.peerName || `Peer-${senderIdOffer}`;
            remotePeers[senderIdOffer] = { name: peerNameOffer };
            addLogMessage(`Received offer from "${peerNameOffer}" (Client ${senderIdOffer})`);
            await handleOffer(message.offer, senderIdOffer, peerNameOffer);
            break;
            
        case 'answer':
            const senderIdAnswer = message.senderId;
            const peerNameAnswer = message.peerName || remotePeers[senderIdAnswer]?.name || `Peer-${senderIdAnswer}`;
            if (message.peerName) {
                remotePeers[senderIdAnswer] = { name: peerNameAnswer };
            }
            addLogMessage(`Received answer from "${peerNameAnswer}" (Client ${senderIdAnswer})`);
            await handleAnswer(message.answer, senderIdAnswer);
            break;
            
        case 'ice-candidate':
            const senderIdIce = message.senderId;
            if (message.candidate && peerConnections[senderIdIce]) {
                await peerConnections[senderIdIce].addIceCandidate(new RTCIceCandidate(message.candidate));
                console.log(`Added ICE candidate from peer ${senderIdIce}`);
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
        
        // Create local canvas dynamically if it doesn't exist
        if (!canvases['localVideo']) {
            const peerInfo = myClientId ? `${myName} (ID: ${myClientId}) - Room: ${roomId}` : 'Not connected';
            canvases['localVideo'] = createVideoCanvas('localVideo', 'Local Camera (You)', peerInfo);
        }
        
        const localCanvas = canvases['localVideo'].canvas;
        initCanvasGL(localCanvas).filterMode = 2;  // use linear interpolation
        initVideoTexture(localCanvas, localStream, 'local');
        
        updateStatus("Local camera started. Waiting for peer...", 'success');
        addLogMessage('Local camera started');
    } catch (error) {
        updateStatus(`Failed to get local stream: ${error.message}`, 'error');
        console.error("Error accessing media devices:", error);
    }
}

async function createPeerConnection(peerId, peerName) {
    const pc = new RTCPeerConnection(configuration);
    peerConnections[peerId] = pc;
    
    // Add local stream tracks to peer connection
    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }
    
    // Handle incoming tracks
    pc.ontrack = (event) => {
        console.log(`Received remote track from peer ${peerId}:`, event.track.kind);
        
        const canvasId = `remote-${peerId}`;
        // Create remote canvas dynamically if it doesn't exist
        if (!canvases[canvasId]) {
            const peerInfo = peerName ? `${peerName} (ID: ${peerId})` : `Peer ${peerId}`;
            canvases[canvasId] = createVideoCanvas(canvasId, peerName || `Peer ${peerId}`, peerInfo);
        }
        
        const remoteCanvas = canvases[canvasId].canvas;
        initCanvasGL(remoteCanvas).filterMode = 2;  // use linear interpolation
        initVideoTexture(remoteCanvas, event.streams[0], canvasId);
        updateStatus(`Remote stream received from "${peerName}"!`, 'success');
    };
    
    // Handle ICE candidates
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(`Sending ICE candidate to peer ${peerId}`);
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
        console.log(`Connection state with peer ${peerId}:`, pc.connectionState);
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            updateStatus(`Connection with peer ${peerId} ${pc.connectionState}`, 'error');
        }
    };
    
    pc.oniceconnectionstatechange = () => {
        console.log(`ICE connection state with peer ${peerId}:`, pc.iceConnectionState);
    };
    
    return pc;
}

async function createAndSendOffer(targetId, peerName) {
    try {
        const pc = await createPeerConnection(targetId, peerName);
        
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        sendSignalingMessage({
            type: 'offer',
            offer: offer,
            targetId: targetId,
            peerName: myName,
            roomId: roomId
        });
        
        addLogMessage(`Sent offer to "${peerName}" (Client ${targetId})`);
        updateStatus(`Calling "${peerName}"...`, 'status');
    } catch (error) {
        updateStatus(`Error creating offer: ${error.message}`, 'error');
        console.error("Error creating offer:", error);
    }
}

async function handleAnswer(answer, peerId) {
    try {
        const pc = peerConnections[peerId];
        if (!pc) {
            console.error(`No peer connection found for peer ${peerId}`);
            return;
        }
        
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        const peerName = remotePeers[peerId]?.name || `Peer ${peerId}`;
        updateStatus(`Connected to "${peerName}"!`, 'success');
        addLogMessage(`Connection established with "${peerName}"`);
        
        // Update remote peer info if canvas exists
        const remotePeerInfo = document.getElementById(`remote-${peerId}PeerInfo`);
        if (remotePeerInfo) {
            remotePeerInfo.textContent = `${peerName} (ID: ${peerId})`;
        }
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
        
        const pc = await createPeerConnection(senderId, peerName);
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
        
        // Update remote peer info if canvas exists
        const remotePeerInfo = document.getElementById(`remote-${senderId}PeerInfo`);
        if (remotePeerInfo) {
            remotePeerInfo.textContent = `${peerName} (ID: ${senderId})`;
        }
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
    // // Event handlers will be added dynamically as canvases are created
    // addEventHandlers(() => {
    //     // Apply filter to all existing canvases
    //     Object.keys(canvases).forEach(canvasId => {
    //         const canvas = canvases[canvasId].canvas;
    //         const gl = canvas.gl;
    //         if (gl) {
    //             gl.filterMode = (gl.filterMode + 1) % 4;
    //             const texture = (gl.filterMode === 0) ? gl.rttFramebufferTextureY.texture : gl.myTexture;
    //             cubicFilter(gl, texture, canvas.width, canvas.height);
    //         }
    //     });
    // });
    
    // Load saved credentials from cookies
    loadCredentialsFromCookies();
    
    // Automatically start local camera
    startLocalVideo();
    
    updateStatus("Ready. Connect to signaling server first.", 'status');
}

// Handle window resize to rebalance grid
window.addEventListener('resize', () => {
    if (Object.keys(canvases).length > 0) {
        rebalanceVideoGrid();
    }
});

window.addEventListener('DOMContentLoaded', webGLStart);
