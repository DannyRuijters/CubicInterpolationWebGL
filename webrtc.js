let localStream = null;
let peerConnection = null;
let localCanvas = null;
let remoteCanvas = null;
let signalingSocket = null;
let myClientId = null;
let myName = '';
let roomId = '';
let remotePeerId = null;
let remotePeerName = '';
let chatEnabled = false;

const SIGNALING_SERVER = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}:${window.location.port}/ws`;

const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

function connectToSignalingServer() {
    myName = document.getElementById('userName').value.trim() || `User-${Date.now() % 10000}`;
    roomId = document.getElementById('roomId').value.trim();
    
    if (!roomId) {
        updateStatus('Please enter a Call ID', 'error');
        return;
    }
    
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
            document.getElementById('startBtn').disabled = false;
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
            document.getElementById('startBtn').disabled = true;
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
    stopVideo();
}

async function handleSignalingMessage(message) {
    console.log('Received signaling message:', message.type);
    
    switch (message.type) {
        case 'welcome':
            myClientId = message.clientId;
            const peersInRoom = message.peersInRoom || (message.totalClients - 1);
            updateStatus(`Connected as "${myName}" (Client ${myClientId}) in room "${roomId}". Peers in room: ${peersInRoom}`, 'success');
            addLogMessage(`You are "${myName}" (Client ${myClientId}) in room "${roomId}"`);
            document.getElementById('localPeerInfo').textContent = `${myName} (ID: ${myClientId}) - Room: ${roomId}`;
            chatEnabled = true;
            document.getElementById('chatInput').disabled = false;
            document.getElementById('sendChatBtn').disabled = false;
            break;
            
        case 'peer-connected':
            if (message.clientId !== myClientId) {
                const peerName = message.peerName || `Peer-${message.clientId}`;
                const peersInRoom = message.peersInRoom || message.totalClients;
                addLogMessage(`"${peerName}" (Client ${message.clientId}) joined room "${roomId}". Peers in room: ${peersInRoom}`);
                updateStatus(`"${peerName}" available in room. Ready to call.`, 'success');
                
                // If we have local stream and no existing connection, automatically call
                if (localStream && !peerConnection) {
                    setTimeout(() => {
                        remotePeerId = message.clientId;
                        remotePeerName = peerName;
                        createAndSendOffer(message.clientId);
                    }, 1000);
                }
            }
            break;
            
        case 'peer-disconnected':
            addLogMessage(`Peer ${message.clientId} disconnected`);
            if (remotePeerId === message.clientId) {
                updateStatus(`"${remotePeerName}" disconnected`, 'error');
                document.getElementById('remotePeerInfo').textContent = 'Not connected';
                if (peerConnection) {
                    peerConnection.close();
                    peerConnection = null;
                }
                remotePeerName = '';
            }
            break;
            
        case 'offer':
            remotePeerName = message.peerName || `Peer-${message.senderId}`;
            addLogMessage(`Received offer from "${remotePeerName}" (Client ${message.senderId})`);
            await handleOffer(message.offer, message.senderId, remotePeerName);
            break;
            
        case 'answer':
            if (message.peerName) {
                remotePeerName = message.peerName;
            }
            addLogMessage(`Received answer from "${remotePeerName}" (Client ${message.senderId})`);
            await handleAnswer(message.answer);
            break;
            
        case 'ice-candidate':
            if (message.candidate && peerConnection) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
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
        
        localCanvas = document.getElementById('localVideo');
        initCanvasGL(localCanvas);
        initVideoTexture(localCanvas, localStream, 'local');
        
        document.getElementById('startBtn').disabled = true;
        document.getElementById('stopBtn').disabled = false;
        
        updateStatus("Local camera started. Waiting for peer...", 'success');
        addLogMessage('Local camera started');
    } catch (error) {
        updateStatus(`Failed to get local stream: ${error.message}`, 'error');
        console.error("Error accessing media devices:", error);
    }
}

async function createPeerConnection() {
    peerConnection = new RTCPeerConnection(configuration);
    
    // Add local stream tracks to peer connection
    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }
    
    // Handle incoming tracks
    peerConnection.ontrack = (event) => {
        console.log('Received remote track:', event.track.kind);
        
        if (!remoteCanvas) {
            remoteCanvas = document.getElementById('remoteVideo');
            initCanvasGL(remoteCanvas);
        }
        
        initVideoTexture(remoteCanvas, event.streams[0], 'remote');
        updateStatus("Remote stream received!", 'success');
    };
    
    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            console.log('Sending ICE candidate to remote peer');
            sendSignalingMessage({
                type: 'ice-candidate',
                candidate: event.candidate,
                targetId: remotePeerId,
                roomId: roomId
            });
        }
    };
    
    // Handle connection state changes
    peerConnection.onconnectionstatechange = () => {
        updateStatus(`Connection state: ${peerConnection.connectionState}`, 'status');
        console.log('Connection state:', peerConnection.connectionState);
    };
    
    peerConnection.oniceconnectionstatechange = () => {
        updateStatus(`ICE connection state: ${peerConnection.iceConnectionState}`, 'status');
        console.log('ICE connection state:', peerConnection.iceConnectionState);
    };
}

async function createAndSendOffer(targetId) {
    try {
        remotePeerId = targetId;
        await createPeerConnection();
        
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        sendSignalingMessage({
            type: 'offer',
            offer: offer,
            targetId: targetId,
            peerName: myName,
            roomId: roomId
        });
        
        addLogMessage(`Sent offer to Client ${targetId}`);
        updateStatus(`Calling "${remotePeerName}"...`, 'status');
    } catch (error) {
        updateStatus(`Error creating offer: ${error.message}`, 'error');
        console.error("Error creating offer:", error);
    }
}

async function handleAnswer(answer) {
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        updateStatus(`Connected to "${remotePeerName}"!`, 'success');
        addLogMessage(`Connection established with "${remotePeerName}"`);
        document.getElementById('remotePeerInfo').textContent = `${remotePeerName} (ID: ${remotePeerId})`;
    } catch (error) {
        updateStatus(`Error handling answer: ${error.message}`, 'error');
        console.error("Error handling answer:", error);
    }
}

async function handleOffer(offer, senderId, peerName) {
    try {
        remotePeerId = senderId;
        remotePeerName = peerName || `Peer-${senderId}`;
        
        if (!localStream) {
            updateStatus(`Received call from "${remotePeerName}" but camera not started. Starting camera...`, 'status');
            await startLocalVideo();
        }
        
        await createPeerConnection();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        sendSignalingMessage({
            type: 'answer',
            answer: answer,
            targetId: senderId,
            peerName: myName,
            roomId: roomId
        });
        
        addLogMessage(`Answered call from "${remotePeerName}"`);
        updateStatus(`Answering call from "${remotePeerName}"...`, 'status');
        document.getElementById('remotePeerInfo').textContent = `${remotePeerName} (ID: ${remotePeerId})`;
    } catch (error) {
        updateStatus(`Error handling offer: ${error.message}`, 'error');
        console.error("Error handling offer:", error);
    }
}

function stopVideo() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    // Clear canvases
    if (localCanvas && localCanvas.intervalID) {
        clearInterval(localCanvas.intervalID);
    }
    if (remoteCanvas && remoteCanvas.intervalID) {
        clearInterval(remoteCanvas.intervalID);
    }
    
    remotePeerId = null;
    
    document.getElementById('startBtn').disabled = signalingSocket ? false : true;
    document.getElementById('stopBtn').disabled = true;
    
    updateStatus("Stopped all video streams", 'status');
    addLogMessage('Video stopped');
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

function webGLStart() {
    const canvasArray = document.getElementsByClassName("gl.cubicinterpolation");
    for (let canvas of canvasArray) {
        addMouseEvents(canvas);
    }

    addEventHandlers(() => {
        const canvasArray = document.getElementsByClassName("gl.cubicinterpolation");
        for (let canvas of canvasArray) {
            const gl = canvas.gl;
            if (gl) {
                gl.filterMode = (gl.filterMode + 1) % 4;
                const texture = (gl.filterMode === 0) ? gl.rttFramebufferTextureY.texture : gl.myTexture;
                cubicFilter(gl, texture, canvas.width, canvas.height);
            }
        }
    });
    
    updateStatus("Ready. Connect to signaling server first.", 'status');
}

window.addEventListener('DOMContentLoaded', webGLStart);
