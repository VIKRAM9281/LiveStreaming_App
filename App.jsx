import React, { useEffect, useRef, useState } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  Button,
  StyleSheet,
  PermissionsAndroid,
  Platform,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import {
  mediaDevices,
  RTCView,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
} from 'react-native-webrtc';
import io from 'socket.io-client';

const socket = io('https://streamingbackend-eh65.onrender.com');

export default function App() {
  const [roomId, setRoomId] = useState('');
  const [joined, setJoined] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isHostStreaming, setIsHostStreaming] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [isHost, setIsHost] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [socketIsConnected, setSocketIsConnected] = useState(socket.connected);

  const peersRef = useRef({});
  const [iceConfig, setIceConfig] = useState({
    iceServers: [
      {
        urls: 'turn:coturn.streamalong.live:3478?transport=udp',
        username: 'vikram',
        credential: 'vikram',
      },
      { urls: 'stun:stun.l.google.com:19302' }, // Fallback STUN server
    ],
  });

  useEffect(() => {
    const fetchICE = async () => {
      console.log('Fetching ICE configuration...');
      try {
        const res = await fetch(
          'https://saluslivestream.metered.live/api/v1/turn/credentials?apiKey=55b40b68db82fa6d95da9a535f2371abbee1'
        );
        const data = await res.json();
        console.log('Fetched ICE servers:', data);
      } catch (err) {
        console.warn('Failed to fetch TURN servers. Using fallback:', err);
      }
    };
    fetchICE();
  }, []);

  useEffect(() => {
    console.log('Setting up local stream...');
    const setupStream = async () => {
      try {
        const permissions = await requestPermissions();
        if (!permissions) {
          throw new Error('Camera and microphone permissions denied');
        }
        const stream = await mediaDevices.getUserMedia({
          audio: true,
          video: { facingMode: 'user' },
        });
        console.log('Local stream setup successful:', stream);
        setLocalStream(stream);
      } catch (err) {
        console.error('Error setting up local stream:', err);
        setError('Failed to access camera or microphone');
      }
    };
    setupStream();
  }, []);

  useEffect(() => {
    console.log('Setting up socket listeners...');
    socket.on('connect', () => {
      console.log('Socket connected');
      setSocketIsConnected(true);
    });
    socket.on('disconnect', () => {
      console.log('Socket disconnected');
      setSocketIsConnected(false);
    });

    socket.on('room-created', () => {
      console.log('Room created');
      setJoined(true);
      setIsHost(true);
      setLoading(false);
    });

    socket.on('room-joined', ({ isHostStreaming }) => {
      console.log('Room joined, host streaming:', isHostStreaming);
      setJoined(true);
      setIsHost(false);
      setIsHostStreaming(isHostStreaming);
      setLoading(false);
    });

    socket.on('room-full', () => {
      console.log('Room is full');
      setLoading(false);
      setError('Room is full');
    });

    socket.on('invalid-room', () => {
      console.log('Invalid room ID');
      setLoading(false);
      setError('Invalid room ID');
    });

    socket.on('room-exists', () => {
      console.log('Room already exists');
      setLoading(false);
      setError('Room already exists');
    });

    socket.on('host-started-streaming', () => {
      console.log('Host started streaming');
      setIsHostStreaming(true);
    });
    socket.on('host-left', () => {
      console.log('Host left');
      setIsHostStreaming(false);
      setJoined(false);
    });
    socket.on('room-closed', endStream);
    socket.on('user-left', handleUserLeft);
    socket.on('user-joined', handleUserJoined);
    socket.on('viewer-joined', handleViewerJoined);
    socket.on('offer', handleReceiveOffer);
    socket.on('answer', handleAnswer);
    socket.on('ice-candidate', handleNewICECandidate);

    return () => {
      console.log('Cleaning up socket listeners...');
      socket.removeAllListeners();
    };
  }, [localStream, iceConfig]);

  const requestPermissions = async () => {
    console.log('Requesting permissions...');
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.CAMERA,
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ]);
      const hasPermissions =
        granted['android.permission.CAMERA'] === PermissionsAndroid.RESULTS.GRANTED &&
        granted['android.permission.RECORD_AUDIO'] === PermissionsAndroid.RESULTS.GRANTED;
      console.log('Permissions granted:', hasPermissions);
      return hasPermissions;
    }
    return true;
  };

  const createOrJoinRoom = async (type) => {
    console.log(`Attempting to ${type} room: ${roomId}`);
    if (!roomId.trim()) {
      console.log('Invalid room ID');
      return setError('Enter a valid room ID');
    }

    setLoading(true);
    setError('');
    if (type === 'create') {
      socket.emit('create-room', roomId);
    } else {
      socket.emit('join-room', roomId);
    }
  };

  const startStream = async () => {
    console.log('Starting stream...');
    try {
      setLoading(true);
      if (!localStream) {
        const stream = await mediaDevices.getUserMedia({
          video: { facingMode: isFrontCamera ? 'user' : 'environment' },
          audio: true,
        });
        setLocalStream(stream);
      }

      setIsStreaming(true);
      socket.emit('host-streaming', roomId);

      for (const id of Object.keys(peersRef.current)) {
        const pc = peersRef.current[id];
        if (!pc || pc.connectionState === 'closed') continue;
        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log(`Sending offer to ${id}:`, offer);
        socket.emit('offer', { target: id, sdp: pc.localDescription });
      }
    } catch (err) {
      console.error('startStream error:', err);
      setError('Failed to start stream');
    } finally {
      setLoading(false);
    }
  };

  const createPeerConnection = (id) => {
    console.log(`Creating peer connection for ${id}`);
    const existingPc = peersRef.current[id];
    if (existingPc && existingPc.connectionState !== 'closed' && existingPc.connectionState !== 'failed') {
      console.log(`Reusing existing peer connection for ${id}`);
      return existingPc;
    }

    const pc = new RTCPeerConnection(iceConfig);
    console.log('New peer connection created:', pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`Sending ICE candidate to ${id}:`, event.candidate);
        socket.emit('ice-candidate', { target: id, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      console.log(`Received remote stream for ${id}:`, event.streams[0]);
      setRemoteStreams((prev) => ({
        ...prev,
        [id]: event.streams[0],
      }));
    };

    pc.onconnectionstatechange = () => {
      console.log(`Peer connection state for ${id}: ${pc.connectionState}`);
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        console.log(`Cleaning up peer connection for ${id}`);
        handleUserLeft(id);
      }
    };

    peersRef.current[id] = pc;
    return pc;
  };

  const handleUserJoined = async (id) => {
    console.log(`Handling user joined: ${id}`);
    if (!isHost) return;

    try {
      if (!localStream || !isStreaming) {
        console.warn('Local stream not ready or not streaming, retrying...');
        setTimeout(() => handleUserJoined(id), 1000);
        return;
      }

      const pc = createPeerConnection(id);
      localStream.getTracks().forEach((track) => {
        console.log(`Adding track to ${id}:`, track);
        pc.addTrack(track, localStream);
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log(`Sending offer to ${id}:`, offer);
      socket.emit('offer', { target: id, sdp: pc.localDescription });
    } catch (error) {
      console.error('Error in handleUserJoined:', error);
    }
  };

  const handleViewerJoined = async (hostId) => {
    console.log(`Handling viewer joined: ${hostId}`);
    if (isHost) return; // Host should not handle viewer-joined

    try {
      const pc = createPeerConnection(hostId);
      if (!pc) {
        console.warn('Failed to create peer connection');
        return;
      }

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log(`Sending offer to host ${hostId}:`, offer);
      socket.emit('offer', { target: hostId, sdp: pc.localDescription });
    } catch (error) {
      console.error('Error in handleViewerJoined:', error);
    }
  };

  const handleReceiveOffer = async ({ sdp, sender }) => {
    console.log(`Received offer from ${sender}:`, sdp);
    try {
      const pc = createPeerConnection(sender);
      if (!pc) {
        console.warn('Failed to create peer connection');
        return;
      }

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log(`Sending answer to ${sender}:`, answer);
      socket.emit('answer', { target: sender, sdp: pc.localDescription });
    } catch (error) {
      console.error('Error in handleReceiveOffer:', error);
    }
  };

  const handleAnswer = async ({ sdp, sender }) => {
    console.log(`Received answer from ${sender}:`, sdp);
    const pc = peersRef.current[sender];
    if (pc) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      } catch (error) {
        console.error('Error in handleAnswer:', error);
      }
    }
  };

  const handleNewICECandidate = async ({ candidate, sender }) => {
    console.log(`Received ICE candidate from ${sender}:`, candidate);
    const pc = peersRef.current[sender];
    if (pc) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.error('Error in handleNewICECandidate:', error);
      }
    }
  };

  const handleUserLeft = (id) => {
    console.log(`User left: ${id}`);
    const pc = peersRef.current[id];
    if (pc) {
      pc.close();
      delete peersRef.current[id];
    }
    setRemoteStreams((prev) => {
      const updated = { ...prev };
      delete updated[id];
      return updated;
    });
  };

  const endStream = () => {
    console.log('Ending stream...');
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      setLocalStream(null);
    }
    Object.values(peersRef.current).forEach((pc) => pc.close());
    peersRef.current = {};
    setIsStreaming(false);
    setJoined(false);
    setIsHost(false);
    setRemoteStreams({});
    socket.emit('leave-room', roomId);
  };

  const switchCamera = async () => {
    console.log('Switching camera...');
    setIsFrontCamera((prev) => !prev);
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
    }
    try {
      const newStream = await mediaDevices.getUserMedia({
        video: { facingMode: isFrontCamera ? 'environment' : 'user' },
        audio: true,
      });
      console.log('Camera switched successfully');
      setLocalStream(newStream);

      Object.values(peersRef.current).forEach((pc) => {
        pc.getSenders().forEach((sender) => {
          const kind = sender.track?.kind;
          const newTrack = newStream.getTracks().find((t) => t.kind === kind);
          if (newTrack) {
            console.log(`Replacing track for ${sender.track?.kind}`);
            sender.replaceTrack(newTrack);
          }
        });
      });
    } catch (error) {
      console.error('Error switching camera:', error);
      setError('Failed to switch camera');
    }
  };

  const renderJoinScreen = () => (
    socketIsConnected ? (
      <>
        <TextInput
          style={styles.input}
          placeholder="Enter Room ID"
          value={roomId}
          onChangeText={setRoomId}
          placeholderTextColor="#999"
        />
        {error && <Text style={styles.errorText}>{error}</Text>}
        {loading && <ActivityIndicator size="large" color="#2196F3" />}
        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.button, styles.createButton]}
            onPress={() => createOrJoinRoom('create')}
            disabled={loading}
          >
            <Text style={styles.buttonText}>Create Room</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.button, styles.joinButton]}
            onPress={() => createOrJoinRoom('join')}
            disabled={loading}
          >
            <Text style={styles.buttonText}>Join Room</Text>
          </TouchableOpacity>
        </View>
      </>
    ) : (
      <Text style={[styles.input, { color: 'red', textAlign: 'center' }]}>
        🚫 Socket is disconnected.
      </Text>
    )
  );

  const renderStreamingScreen = () => (
    <>
      {localStream && typeof localStream.toURL === 'function' && (
        <RTCView
          streamURL={localStream.toURL()}
          style={styles.fullScreenVideo}
          objectFit="cover"
          mirror={isFrontCamera}
        />
      )}
      <View style={styles.bottomOverlay}>
        <Button title="Switch Camera" onPress={switchCamera} disabled={loading} />
        <Button title="End Stream" color="red" onPress={endStream} disabled={loading} />
      </View>
    </>
  );

  const renderViewerScreen = () => {
    const remoteStream = Object.values(remoteStreams)[0];
    const isStreamAvailable =
      remoteStream && typeof remoteStream.toURL === 'function';

    return (
      <>
        {isHostStreaming && isStreamAvailable ? (
          <RTCView
            streamURL={remoteStream.toURL()}
            style={styles.fullScreenVideo}
          />
        ) : (
          <View style={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}>
            <ActivityIndicator size="large" color="#2196F3" />
            <Text style={{ color: 'white', marginTop: 10 }}>
              Waiting for host to start streaming...
            </Text>
          </View>
        )}
        <Button title="Leave Room" color="red" onPress={endStream} disabled={loading} />
      </>
    );
  };

  const renderHostControls = () => (
    <>
      <Button
        title="Start Streaming"
        onPress={startStream}
        disabled={loading || isStreaming || !localStream}
      />
      <Button title="End Stream" color="red" onPress={endStream} disabled={loading} />
    </>
  );

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>🎥 Live Stream App</Text>
      {!joined && renderJoinScreen()}
      {joined && isHost && !isStreaming && renderHostControls()}
      {joined && !isHost && renderViewerScreen()}
      {isStreaming && renderStreamingScreen()}
      {error && <Text style={styles.errorText}>{error}</Text>}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', padding: 15 },
  title: { color: '#fff', textAlign: 'center', fontSize: 20, margin: 10 },
  input: { backgroundColor: '#222', color: '#fff', padding: 10, borderRadius: 8, marginVertical: 10 },
  buttonRow: { flexDirection: 'row', justifyContent: 'space-between' },
  button: { padding: 15, borderRadius: 8, marginHorizontal: 5 },
  createButton: { backgroundColor: '#4CAF50' },
  joinButton: { backgroundColor: '#2196F3' },
  buttonText: { color: '#fff', fontWeight: 'bold' },
  fullScreenVideo: { flex: 1, width: '100%', backgroundColor: '#000' },
  bottomOverlay: { padding: 10, backgroundColor: '#111' },
  errorText: { color: 'red', textAlign: 'center', marginVertical: 10 },
});