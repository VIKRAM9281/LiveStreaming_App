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
  ScrollView,
} from 'react-native';

import {
  mediaDevices,
  RTCView,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
} from 'react-native-webrtc';

import io from 'socket.io-client';

const socket = io('http://192.168.0.18:5000');

const configuration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

export default function App() {
  const [roomId, setRoomId] = useState('');
  const [joined, setJoined] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [isFrontCamera, setIsFrontCamera] = useState(true);

  const peersRef = useRef({});

  useEffect(() => {
    socket.on('connect', () => console.log('✅ Connected to socket.io:', socket.id));

    socket.on('room-created', () => {
      console.log('🛠 Room created');
      setJoined(true);
    });

    socket.on('room-joined', () => {
      console.log('👋 Room joined');
      setJoined(true);
    });

    socket.on('room-full', () => alert('Room is full'));

    socket.on('user-joined', handleUserJoined);
    socket.on('offer', handleReceiveOffer);
    socket.on('answer', handleAnswer);
    socket.on('ice-candidate', handleNewICECandidate);
    socket.on('user-left', handleUserLeft);
  }, []);

  const requestPermissions = async () => {
    if (Platform.OS === 'android') {
      try {
        await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.CAMERA,
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        ]);
      } catch (err) {
        console.warn('Permission error:', err);
      }
    }
  };

  const createOrJoinRoom = async (type) => {
    await requestPermissions();
    if (type === 'create') {
      socket.emit('create-room', roomId);
    } else {
      socket.emit('join-room', roomId);
    }
  };

  const startStream = async () => {
    try {
      const stream = await mediaDevices.getUserMedia({
        video: { facingMode: isFrontCamera ? 'user' : 'environment' },
        audio: true,
      });

      setLocalStream(stream);
      setIsStreaming(true);

      Object.keys(peersRef.current).forEach(async (id) => {
        const pc = peersRef.current[id];
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { target: id, sdp: pc.localDescription });
      });
      setRoomId('');
    } catch (error) {
      console.error('❌ Error getting stream:', error);
    }
  };

  const switchCamera = async () => {
    setIsFrontCamera((prev) => !prev);

    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
    }

    const newStream = await mediaDevices.getUserMedia({
      video: { facingMode: !isFrontCamera ? 'user' : 'environment' },
      audio: true,
    });

    setLocalStream(newStream);

    Object.values(peersRef.current).forEach((pc) => {
      pc.getSenders().forEach((sender) => {
        const kind = sender.track?.kind;
        const newTrack = newStream.getTracks().find((t) => t.kind === kind);
        if (newTrack) {
          sender.replaceTrack(newTrack);
        }
      });
    });
  };

  const endStream = () => {
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      setLocalStream(null);
    }
    setIsStreaming(false);
    setJoined(false);
    setRemoteStreams({});
    peersRef.current = {};
  };

  const createPeerConnection = (id) => {
    const pc = new RTCPeerConnection(configuration);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', {
          target: id,
          candidate: event.candidate,
        });
      }
    };

    pc.ontrack = (event) => {
      setRemoteStreams((prev) => ({
        ...prev,
        [id]: event.streams[0],
      }));
    };

    peersRef.current[id] = pc;
    return pc;
  };

  const handleUserJoined = async (id) => {
    const pc = createPeerConnection(id);
    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { target: id, sdp: pc.localDescription });
  };

  const handleReceiveOffer = async ({ sdp, target }) => {
    const pc = createPeerConnection(target);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { target, sdp: pc.localDescription });
  };

  const handleAnswer = async ({ sdp, target }) => {
    const pc = peersRef.current[target];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  };

  const handleNewICECandidate = async ({ candidate, target }) => {
    const pc = peersRef.current[target];
    if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
  };

  const handleUserLeft = (id) => {
    if (peersRef.current[id]) {
      peersRef.current[id].close();
      delete peersRef.current[id];
    }
    setRemoteStreams((prev) => {
      const updated = { ...prev };
      delete updated[id];
      return updated;
    });
  };

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>🎥 React Native Live Stream</Text>

      {!isStreaming && (
        <>
          <TextInput
            style={styles.input}
            placeholder="Enter Room ID"
            value={roomId}
            onChangeText={setRoomId}
          />
          <View style={styles.buttonRow}>
            <Button title="Create Room" onPress={() => createOrJoinRoom('create')} />
            <Button title="Join Room" onPress={() => createOrJoinRoom('join')} />
          </View>
        </>
      )}

      {joined && !isStreaming && (
        <Button title="Start Streaming" onPress={startStream} />
      )}

      {localStream && isStreaming && (
        <>
          <RTCView
            streamURL={localStream.toURL()}
            style={styles.fullScreenVideo}
            objectFit="cover"
            mirror={isFrontCamera}
          />
          <View style={styles.bottomOverlay}>
            <Text style={styles.userCountText}>
              👥 {Object.keys(peersRef.current).length} viewer(s)
            </Text>
            <Button title="Switch Camera" onPress={switchCamera} />
            <View style={{ height: 10 }} />
            <Button title="End Streaming" color="red" onPress={endStream} />
          </View>

          <ScrollView horizontal style={styles.remoteContainer}>
            {Object.entries(remoteStreams).map(([id, stream]) => (
              <RTCView
                key={id}
                streamURL={stream.toURL()}
                style={styles.remoteVideo}
                objectFit="cover"
              />
            ))}
          </ScrollView>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    marginTop: 10,
    color: '#fff',
    textAlign: 'center',
  },
  input: {
    borderColor: '#ccc',
    borderWidth: 1,
    backgroundColor: '#fff',
    margin: 15,
    paddingHorizontal: 10,
    height: 40,
    borderRadius: 5,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    marginBottom: 15,
  },
  fullScreenVideo: {
    flex: 1,
    width: '100%',
    backgroundColor: 'black',
  },
  bottomOverlay: {
    position: 'absolute',
    bottom: 20,
    width: '100%',
    alignItems: 'center',
  },
  userCountText: {
    color: '#fff',
    fontSize: 16,
    marginBottom: 10,
  },
  remoteContainer: {
    position: 'absolute',
    bottom: 100,
    paddingHorizontal: 10,
    flexDirection: 'row',
  },
  remoteVideo: {
    width: 100,
    height: 150,
    margin: 5,
  },
});