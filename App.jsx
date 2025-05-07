import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Button,
  ScrollView,
  PermissionsAndroid,
  Platform,
  StyleSheet,
} from 'react-native';
import { ActivityIndicator } from 'react-native';
import { RTCView, mediaDevices, RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from 'react-native-webrtc';
import { ErrorUtils } from 'react-native';
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
  const [isMuted, setIsMuted] = useState(false);
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [loading, setLoading] = useState(false);

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
    requestPermissions();

    socket.on('room-created', ({ roomId }) => {
      setJoined(true);
      setIsHost(true);
      setHostId(socket.id);
      setLoading(false);
    });

    socket.on('room-joined', ({ roomId, hostId, isHostStreaming, viewerCount }) => {
      setJoined(true);
      setIsHost(false);
      setHostId(hostId);
      setViewerCount(viewerCount);
      setIsStreaming(isHostStreaming);
      setLoading(false);
    });

socket.on('room-full', () => {
  setError('Room is full. Cannot join.');
  setLoading(false);
});

socket.on('invalid-room', () => {
  setError('Invalid room ID.');
  setLoading(false);
});

socket.on('room-exists', () => {
  setError('Room already exists.');
  setLoading(false);
});
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

      setTimeout(async () => {
        try {
          const offer = await peerConnection.createOffer({
            offerToReceiveAudio: false,
            offerToReceiveVideo: false,
          });
          await peerConnection.setLocalDescription(offer);
          socket.emit('offer', { target: viewerId, sdp: offer });
        } catch (err) {
          console.error('Offer error:', err);
        }
      }, 500);
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
     setLoading(true);
    socket.emit('create-room', roomId);
  };

  const joinRoom = () => {
    if (roomId.trim() === '') return setError('Please enter a room ID.');
     setLoading(true);
    socket.emit('join-room', roomId);
  };

  const startStreaming = async () => {
    try {
      await requestPermissions();
      const stream = await mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      localStreamRef.current = stream;

      peerConnectionRef.current = new RTCPeerConnection(iceServers);
      stream.getTracks().forEach(track => {
        peerConnectionRef.current.addTrack(track, stream);
      });

      peerConnectionRef.current.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('Host ICE candidate:', event.candidate);
        }
      };

      socket.emit('host-streaming', roomId);
    } catch (err) {
      console.error('Streaming error:', err);
      setError('Failed to start streaming.');
    }
  };

  const leaveRoom = () => {
    socket.emit('leave-room');
    setJoined(false);
    setIsStreaming(false);
    setViewers([]);
    setRoomId('');
    setTimeout(()=>{
        setError("")
    },4000)

    localStream?.getTracks().forEach(track => track.stop());
    remoteStream?.getTracks().forEach(track => track.stop());
    Object.values(peerConnections.current).forEach(pc => pc.close());
    peerConnections.current = {};
  };

  const toggleMute = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsMuted(prev => !prev);
    }
  };

  const switchCamera = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current
        .getVideoTracks()
        .find(track => typeof track._switchCamera === 'function');

      if (videoTrack) {
        videoTrack._switchCamera();
        setIsFrontCamera(prev => !prev);
      }
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>🎥 Live Streaming App</Text>

      {!joined ? (
        <View>
          <TextInput
            placeholder="Enter Room ID"
            value={roomId}
            onChangeText={setRoomId}
            style={styles.input}
          />
        {loading ? (
         <ActivityIndicator size="large" color="#0000ff" style={{ marginTop: 20 }} />
        ) : (
          <>
            <Button title="Create Room" onPress={createRoom} />
            <Button title="Join Room" onPress={joinRoom} color="green" />
          </>
        )}
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      ) : (
        <View style={styles.roomInfo}>
          <Text>Room ID: {roomId}</Text>
          <Text>You are the {isHost ? 'Host' : 'Viewer'}</Text>
          <Text>👁️ Viewers: {viewerCount}</Text>

          {isHost && (
            <View style={styles.streamBox}>
              {localStream && (
                <RTCView
                  streamURL={localStream.toURL()}
                  style={styles.video}
                  objectFit="cover"
                  mirror={isFrontCamera}
                />
              )}
              <View style={styles.controls}>
                <Button title={isMuted ? "Unmute" : "Mute"} onPress={toggleMute} />
                <Button title="Switch Camera" onPress={switchCamera} />
              </View>
              {!isStreaming ? (
                <Button title="Start Streaming" onPress={startStreaming} />
              ) : (
                <Text style={{ color: 'green' }}>🔴 Streaming Live</Text>
              )}
            </View>
          )}

          {!isHost && isStreaming && remoteStream && (
            <View style={styles.streamBox}>
              <RTCView
                streamURL={remoteStream.toURL()}
                style={styles.video}
                objectFit="cover"
                mirror={true}
              />
              <Text>📡 Watching stream...</Text>
              <Text>👁️ Viewers: {viewerCount}</Text>
            </View>
          )}

          <Button title="Leave Room" onPress={leaveRoom} color="red" />
        </View>
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
    paddingBottom: 50,
    backgroundColor: '#f2f2f2',
  },
  title: {
    fontSize: 26,
    fontWeight: 'bold',
    marginBottom: 16,
    textAlign: 'center',
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 10,
    marginVertical: 10,
    backgroundColor: '#fff',
  },
  error: {
    color: 'red',
    marginTop: 10,
  },
  roomInfo: {
    marginTop: 20,
  },
  streamBox: {
    marginVertical: 20,
    alignItems: 'center',
  },
  video: {
    width: '100%',
    height: 300,
    backgroundColor: '#000',
    borderRadius: 10,
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginVertical: 10,
    width: '100%',
  },
});

export default App;
