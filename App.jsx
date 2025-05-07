import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Button,
  ScrollView,
  PermissionsAndroid,
  Platform
} from 'react-native';
import { ErrorUtils } from 'react-native';
import { RTCView, mediaDevices, RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from 'react-native-webrtc';
import io from 'socket.io-client';
const socket = io('https://streamingbackend-eh65.onrender.com', {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
});

const iceServers = {
  iceServers: [
    {
      urls: 'turn:coturn.streamalong.live:3478?transport=udp',
      username: 'vikram',
      credential: 'vikram',
    },
  ],
};

const App = () => {
  const [roomId, setRoomId] = useState('');
  const [joined, setJoined] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [hostId, setHostId] = useState('');
  const [viewerCount, setViewerCount] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState('');
  const [viewers, setViewers] = useState([]);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);

  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnections = useRef({});
const requestPermissions = async () => {
  if (Platform.OS === 'android') {
    const granted = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.CAMERA,
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    ]);
    const allGranted = Object.values(granted).every(value => value === PermissionsAndroid.RESULTS.GRANTED);
    if (!allGranted) {
      throw new Error('Permissions not granted');
    }
  }
};
  useEffect(() => {
requestPermissions()
    socket.on('room-created', ({ roomId }) => {
      setJoined(true);
      setIsHost(true);
      setHostId(socket.id);
    });

    socket.on('room-joined', ({ roomId, hostId, isHostStreaming, viewerCount }) => {
      setJoined(true);
      setIsHost(false);
      setHostId(hostId);
      setViewerCount(viewerCount);
      setIsStreaming(isHostStreaming);
    });

    socket.on('room-full', () => setError('Room is full. Cannot join.'));
    socket.on('invalid-room', () => setError('Invalid room ID.'));
    socket.on('room-exists', () => setError('Room already exists.'));
    socket.on('room-info', ({ viewerCount }) => setViewerCount(viewerCount));

socket.on('user-joined', (viewerId) => {
  if (!localStreamRef.current || localStreamRef.current.getTracks().length === 0) {
    console.warn('Viewer joined but local stream not ready');
    return;
  }

  const peerConnection = new RTCPeerConnection(iceServers);

  localStreamRef.current.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStreamRef.current);
  });

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { target: viewerId, candidate: event.candidate });
    }
  };

  peerConnections.current[viewerId] = peerConnection;

  // ⏱ Delay offer creation to prevent native crash
  setTimeout(async () => {
    try {
      console.log('Creating offer for viewer:', viewerId);
      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false
      });

      console.log('Offer created:', offer.sdp);
      console.log(`localStreamRef.current`, localStreamRef.current)
    if( peerConnection?.setLocalDescription){
      await peerConnection.setLocalDescription(offer);
      console.log('Local description set');
      socket.emit('offer', { target: viewerId, sdp: offer });
    }else{
         console.log(peerConnection);
         console.log(peerConnection?.setLocalDescription);
        }

    } catch (err) {
      console.error('Offer/setLocalDescription crash:', err);
    }
  }, 500); // ← Delay increased to 500ms for native safety
});



    socket.on('user-left', (viewerId) => {
      setViewers(prev => prev.filter(id => id !== viewerId));
      if (peerConnections.current[viewerId]) {
        peerConnections.current[viewerId].close();
        delete peerConnections.current[viewerId];
      }
    });

    socket.on('host-started-streaming', () => setIsStreaming(true));

    socket.on('ice-candidate', ({ candidate, sender }) => {
      const pc = peerConnections.current[sender] || peerConnectionRef.current;
      if (pc && candidate) {
        pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    socket.on('offer', async ({ sdp, sender }) => {
      const peerConnection = new RTCPeerConnection(iceServers);
      peerConnection.ontrack = (event) => {
        setRemoteStream(event.streams[0]);
      };
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', { target: sender, candidate: event.candidate });
        }
      };
      await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('answer', { target: sender, sdp: answer });
      peerConnectionRef.current = peerConnection;
    });

    socket.on('answer', async ({ sdp, sender }) => {
      const pc = peerConnections.current[sender];
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      }
    });

    socket.on('host-left', () => {
      setError('Host has left the room.');
      setJoined(false);
      setIsStreaming(false);
    });

    socket.on('room-closed', () => {
      setError('Room has been closed.');
      setJoined(false);
      setIsStreaming(false);
    });

    return () => socket.removeAllListeners();
  }, []);

  const createRoom = () => {
    if (roomId.trim() === '') return setError('Please enter a room ID.');
    socket.emit('create-room', roomId);
  };

  const joinRoom = () => {
    if (roomId.trim() === '') return setError('Please enter a room ID.');
    socket.emit('join-room', roomId);
  };

const startStreaming = async () => {
  try {
    await requestPermissions();

    const stream = await mediaDevices.getUserMedia({ video: true, audio: true });
    setLocalStream(stream);
    console.log(stream)
    localStreamRef.current = stream;

    // No need to create offer here; this peer connection is for receiving offers if needed
    peerConnectionRef.current = new RTCPeerConnection(iceServers);

    stream.getTracks().forEach(track => {
      peerConnectionRef.current.addTrack(track, stream);
    });

    peerConnectionRef.current.onicecandidate = (event) => {
      if (event.candidate) {
        // Not needed to send to hostId, host is already host
        console.log("ICE candidate from host", event.candidate);
      }
    };

    socket.emit('host-streaming', roomId); // Notify server you're ready to accept viewers
  } catch (err) {
    console.error('Streaming error:', err);
    setError('Failed to start streaming.');
  }
};
ErrorUtils?.setGlobalHandler((error, isFatal) => {
  console.log('Global error caught:', error.stack);
  // Send to logging service if needed
});
  const leaveRoom = () => {
    socket.emit('leave-room');
    setJoined(false);
    setIsStreaming(false);
    setViewers([]);
    setRoomId('');
    localStream?.getTracks().forEach(track => track.stop());
    remoteStream?.getTracks().forEach(track => track.stop());
    Object.values(peerConnections.current).forEach(pc => pc.close());
    peerConnections.current = {};
  };

  return (
    <ScrollView style={{ padding: 16 }}>
      <Text style={{ fontSize: 24, fontWeight: 'bold' }}>Live Streaming App</Text>
      {!joined ? (
        <View>
          <TextInput
            placeholder="Enter Room ID"
            value={roomId}
            onChangeText={setRoomId}
            style={{ borderWidth: 1, marginVertical: 8, padding: 8 }}
          />
          <Button title="Create Room" onPress={createRoom} />
          <Button title="Join Room" onPress={joinRoom} />
          {error ? <Text style={{ color: 'red' }}>{error}</Text> : null}
        </View>
      ) : (
        <View>
          <Text>Room ID: {roomId}</Text>
          <Text>You are the {isHost ? 'Host' : 'Viewer'}</Text>
          <Text>Viewers: {viewerCount} / 5</Text>

          {isHost && (
            <View>
                {localStream && (
                  <RTCView
                    streamURL={localStream.toURL()}
                    style={{ width: 200, height: 150 }}
                    objectFit="cover"
                    mirror={true}
                  />
                )}
              {!isStreaming ? (
                <Button title="Start Streaming" onPress={startStreaming} />
              ) : (
                <Text>Streaming...</Text>
              )}
              <Text>Viewers:</Text>
              {viewers.map(id => <Text key={id}>{id}</Text>)}
            </View>
          )}

          {!isHost && isStreaming && remoteStream && (
            <View>
              <RTCView
                streamURL={remoteStream.toURL()}
                style={{ width: '100%', height: 200, backgroundColor: 'black' }}
                objectFit="cover"
                 mirror={true}
              />
              <Text>Watching the stream...</Text>
            </View>
          )}

          <Button title="Leave Room" onPress={leaveRoom} />
        </View>
      )}
    </ScrollView>
  );
};

export default App;
