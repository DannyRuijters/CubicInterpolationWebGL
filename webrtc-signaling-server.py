#!/usr/bin/env python3

"""
WebSocket Signaling Server for WebRTC
Simple signaling server to exchange SDP offers/answers and ICE candidates

Usage: python signaling-server.py [--port PORT]
Default port: 8080
"""

import asyncio
import json
import logging
import signal
import sys, os, argparse
from datetime import datetime
from typing import Dict, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
from fastapi.responses import HTMLResponse
from fastapi.responses import Response
from fastapi.responses import Response
import uvicorn

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

# FastAPI app
app = FastAPI(title="WebRTC Signaling Server")

# Store connected clients with their IDs
clients: Dict[int, WebSocket] = {}
client_id_counter = 0


class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[int, WebSocket] = {}
        self.client_names: Dict[int, str] = {}
        self.client_rooms: Dict[int, str] = {}
        self.client_counter = 0

    def disconnect(self, client_id: int):
        if client_id in self.active_connections:
            del self.active_connections[client_id]
            if client_id in self.client_names:
                del self.client_names[client_id]
            if client_id in self.client_rooms:
                del self.client_rooms[client_id]
            logger.info(f"Client {client_id} disconnected. Total clients: {len(self.active_connections)}")

    def get_peers_in_room(self, room_id: str) -> list:
        """Get list of client IDs in the specified room"""
        return [cid for cid, rid in self.client_rooms.items() if rid == room_id]

    async def send_personal_message(self, message: dict, client_id: int):
        if client_id in self.active_connections:
            try:
                await self.active_connections[client_id].send_json(message)
            except Exception as e:
                logger.error(f"Error sending message to client {client_id}: {e}")

    async def broadcast(self, message: dict, exclude_client_id: int = None, room_id: str = None):
        """Broadcast message to all clients, optionally filtered by room"""
        disconnected_clients = []
        for client_id, connection in self.active_connections.items():
            if client_id != exclude_client_id:
                # If room_id is specified, only send to clients in that room
                if room_id is None or self.client_rooms.get(client_id) == room_id:
                    try:
                        await connection.send_json(message)
                    except Exception as e:
                        logger.error(f"Error broadcasting to client {client_id}: {e}")
                        disconnected_clients.append(client_id)
        
        # Clean up disconnected clients
        for client_id in disconnected_clients:
            self.disconnect(client_id)


manager = ConnectionManager()


@app.get("/")
async def root():
    # Read and return the webrtc.html file
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        webrtc_path = os.path.join(script_dir, 'webrtc.html')
        with open(webrtc_path, 'r') as f:
            return HTMLResponse(content=f.read(), status_code=200)
    except FileNotFoundError:
        return PlainTextResponse("WebRTC Signaling Server is running\n", status_code=200)
    except Exception as e:
        logger.error(f"Error reading webrtc.html: {e}")
        return PlainTextResponse("Internal server error", status_code=500)


@app.get("/{filename:path}")
async def serve_file(filename: str):
    """Serve static files from the current directory"""
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        file_path = os.path.join(script_dir, filename)
        
        # Security check: ensure the file is within the script directory
        if not os.path.abspath(file_path).startswith(script_dir):
            return PlainTextResponse("Access denied", status_code=403)
        
        # Check if file exists and is a file (not a directory)
        if os.path.isfile(file_path):
            with open(file_path, 'r') as f:
                content = f.read()
            
            # Determine content type based on file extension
            if filename.endswith('.html'):
                return HTMLResponse(content=content)
            elif filename.endswith('.js'):
                return Response(content=content, media_type="application/javascript")
            elif filename.endswith('.css'):
                return Response(content=content, media_type="text/css")
            else:
                return PlainTextResponse(content)
        else:
            return PlainTextResponse("File not found", status_code=404)
            
    except Exception as e:
        logger.error(f"Error serving file {filename}: {e}")
        return PlainTextResponse("Internal server error", status_code=500)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    client_id = None
    room_id = None
    
    try:
        # Accept connection first
        await websocket.accept()
        
        # Wait for first message which must contain peer name and room ID
        first_data = await websocket.receive_json()
        peer_name = first_data.get("peerName") or first_data.get("name")
        room_id = first_data.get("roomId") or "default"
        
        # Now register the client
        manager.client_counter += 1
        client_id = manager.client_counter
        manager.active_connections[client_id] = websocket
        if peer_name:
            manager.client_names[client_id] = peer_name
        manager.client_rooms[client_id] = room_id
        
        peers_in_room = manager.get_peers_in_room(room_id)
        peers_count = len(peers_in_room) - 1  # Exclude self
        
        logger.info(f"Client {client_id} ('{peer_name or 'Unnamed'}') joined room '{room_id}'. Peers in room: {peers_count}")
        
        # Send welcome message
        await websocket.send_json({
            "type": "welcome",
            "clientId": client_id,
            "totalClients": len(manager.active_connections),
            "peersInRoom": peers_count
        })
        
        # Broadcast to other clients IN THE SAME ROOM only
        await manager.broadcast({
            "type": "peer-connected",
            "clientId": client_id,
            "peerName": peer_name,
            "totalClients": len(manager.active_connections),
            "peersInRoom": len(peers_in_room)
        }, exclude_client_id=client_id, room_id=room_id)
        
        # Process the first message if it's a signaling message
        message_type = first_data.get("type", "unknown")
        if message_type in ["offer", "answer", "ice-candidate"]:
            logger.info(f"Client {client_id} sent: {message_type}")
            target_id = first_data.get("targetId")
            if target_id:
                # Verify target is in same room
                if manager.client_rooms.get(target_id) == room_id:
                    if target_id in manager.active_connections:
                        message = {**first_data, "senderId": client_id}
                        await manager.send_personal_message(message, target_id)
                        logger.info(f"  → Forwarded to client {target_id}")
                else:
                    logger.info(f"  ✗ Target client {target_id} is not in the same room")
        
        # Continue with regular message loop
        # Continue with regular message loop
        while True:
            # Receive message from client
            data = await websocket.receive_json()
            message_type = data.get("type", "unknown")
            
            # Update peer name if provided
            if "peerName" in data and client_id:
                manager.client_names[client_id] = data["peerName"]
            
            logger.info(f"Client {client_id} sent: {message_type}")
            
            # Handle different message types
            if message_type in ["offer", "answer", "ice-candidate"]:
                target_id = data.get("targetId")
                
                if target_id:
                    # Verify target is in same room
                    target_room = manager.client_rooms.get(target_id)
                    if target_room == room_id:
                        # Forward to specific peer in same room
                        if target_id in manager.active_connections:
                            message = {**data, "senderId": client_id}
                            await manager.send_personal_message(message, target_id)
                            logger.info(f"  → Forwarded to client {target_id} in room '{room_id}'")
                        else:
                            logger.info(f"  ✗ Target client {target_id} not found or not ready")
                    else:
                        logger.info(f"  ✗ Target client {target_id} is in different room ('{target_room}' vs '{room_id}')")
                else:
                    # Broadcast to all other clients in same room
                    message = {**data, "senderId": client_id}
                    await manager.broadcast(message, exclude_client_id=client_id, room_id=room_id)
                    logger.info(f"  → Broadcasted to peers in room '{room_id}'")
                    
            elif message_type == "chat":
                # Relay chat message to all peers in same room
                chat_text = data.get("text", "")
                sender_name = data.get("senderName", f"Client {client_id}")
                message = {
                    "type": "chat",
                    "text": chat_text,
                    "senderId": client_id,
                    "senderName": sender_name,
                    "timestamp": data.get("timestamp")
                }
                await manager.broadcast(message, exclude_client_id=client_id, room_id=room_id)
                logger.info(f"  → Chat message from '{sender_name}' broadcasted to room '{room_id}'")
                    
            elif message_type == "get-peers":
                # Send list of available peers in same room
                peer_list = [cid for cid in manager.get_peers_in_room(room_id) if cid != client_id]
                await websocket.send_json({
                    "type": "peer-list",
                    "peers": peer_list
                })
                
            else:
                logger.info(f"  ? Unknown message type: {message_type}")
                
    except WebSocketDisconnect:
        if client_id:
            manager.disconnect(client_id)
            # Notify other clients in the same room
            if room_id:
                peers_in_room = manager.get_peers_in_room(room_id)
                await manager.broadcast({
                    "type": "peer-disconnected",
                    "clientId": client_id,
                    "totalClients": len(manager.active_connections),
                    "peersInRoom": len(peers_in_room)
                }, exclude_client_id=client_id, room_id=room_id)
        
    except Exception as e:
        logger.error(f"Error handling client {client_id}: {e}")
        if client_id:
            manager.disconnect(client_id)
            if room_id:
                peers_in_room = manager.get_peers_in_room(room_id)
                await manager.broadcast({
                    "type": "peer-disconnected",
                    "clientId": client_id,
                    "totalClients": len(manager.active_connections),
                    "peersInRoom": len(peers_in_room)
                }, exclude_client_id=client_id, room_id=room_id)


def signal_handler(signum, frame):
    """Handle graceful shutdown"""
    logger.info(f"\nReceived signal {signum}, shutting down...")
    sys.exit(0)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="WebRTC Signaling Server")
    parser.add_argument("--port", type=int, default=8080, help="Port to listen on (default: 8080)")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host to bind to (default: 0.0.0.0)")
    args = parser.parse_args()
    
    # Setup signal handlers for graceful shutdown
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)
    
    print("\n========================================")
    print("WebRTC Signaling Server")
    print("========================================")
    print(f"WebSocket server listening on port {args.port}")
    print(f"ws://{args.host}:{args.port}")
    print("========================================\n")
    
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level="info"
    )
