import React, { useEffect, useRef, useState, createContext, useContext } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  TouchableOpacity,
  Alert,
  FlatList,
  Animated,
} from 'react-native';
import { ActivityIndicator, Dimensions } from 'react-native';
import { RTCView, mediaDevices, RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from 'react-native-webrtc';
import io from 'socket.io-client';
import Icon from 'react-native-vector-icons/MaterialIcons';

// Theme Context
const ThemeContext = createContext();

const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = useState('dark');

  const toggleTheme = () => {
    setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

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

const { width, height } = Dimensions.get('window');

const App = () => {
  const { theme, toggleTheme } = useContext(ThemeContext);
  const [roomId, setRoomId] = useState('');
  const [joined, setJoined] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [hostId, setHostId] = useState('');
  const [viewerCount, setViewerCount] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState('');
  const [viewers, setViewers] = useState([]);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [loading, setLoading] = useState(false);
  const [streamRequest, setStreamRequest] = useState(null);
  const [hasRequestedStream, setHasRequestedStream] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [reactions, setReactions] = useState([]);
  const [streamQuality, setStreamQuality] = useState('720p');
  const [viewerList, setViewerList] = useState([]);
  const [streamStats, setStreamStats] = useState({ duration: 0, peakViewers: 0 });
  const [approvedStreamers, setApprovedStreamers] = useState([]);

  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnections = useRef({});
  const chatScrollRef = useRef(null);
  const reactionAnim = useRef(new Animated.Value(0)).current;

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

    socket.on('room-joined', ({ roomId, hostId, isHostStreaming, viewerCount, viewerList, messages }) => {
      setJoined(true);
      setIsHost(false);
      setHostId(hostId);
      setViewerCount(viewerCount);
      setViewerList(viewerList);
      setIsStreaming(isHostStreaming);
      setChatMessages(messages.map((msg, idx) => ({ ...msg, id: idx })));
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

    socket.on('room-info', ({ viewerCount, viewerList }) => {
      setViewerCount(viewerCount);
      setViewerList(viewerList);
      setStreamStats(prev => ({ ...prev, peakViewers: Math.max(prev.peakViewers, viewerCount) }));
    });

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
      setViewerList(prev => prev.filter(id => id !== viewerId));
      setApprovedStreamers(prev => prev.filter(s => s !== viewerId));
      setRemoteStreams(prev => prev.filter(s => s.id !== viewerId));
      if (peerConnections.current[viewerId]) {
        peerConnections.current[viewerId].close();
        delete peerConnections.current[viewerId];
      }
    });

    socket.on('host-started-streaming', () => {
      setIsStreaming(true);
    });

    socket.on('host-stopped-streaming', () => {
      setIsStreaming(false);
      setRemoteStreams(prev => prev.filter(s => s.id !== hostId));
    });

    socket.on('user-started-streaming', ({ streamerId }) => {
      setApprovedStreamers(prev => [...new Set([...prev, streamerId])]);
    });

    socket.on('ice-candidate', ({ candidate, sender }) => {
      const pc = peerConnections.current[sender] || peerConnectionRef.current;
      if (pc && candidate) {
        pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => console.error('ICE error:', err));
      }
    });

    socket.on('offer', async ({ sdp, sender }) => {
      const peerConnection = new RTCPeerConnection(iceServers);
      peerConnection.ontrack = (event) => {
        setRemoteStreams(prev => {
          const existing = prev.find(s => s.id === sender);
          if (!existing) {
            return [...prev, { id: sender, stream: event.streams[0] }];
          }
          return prev;
        });
      };
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', { target: sender, candidate: event.candidate });
        }
      };
      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('answer', { target: sender, sdp: answer });
        peerConnections.current[sender] = peerConnection;
      } catch (err) {
        console.error('Offer handling error:', err);
      }
    });

    socket.on('answer', async ({ sdp, sender }) => {
      const pc = peerConnections.current[sender];
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        } catch (err) {
          console.error('Answer handling error:', err);
        }
      }
    });

    socket.on('host-left', () => {
      setError('Host has left the room. Meeting ended.');
      leaveRoom();
    });

    socket.on('room-closed', () => {
      setError('Room has been closed.');
      leaveRoom();
    });

    socket.on('stream-request', ({ viewerId }) => {
      if (isHost) {
        setStreamRequest({ viewerId });
        Alert.alert(
          'Stream Request',
          `Viewer ${viewerId} wants to stream. Allow?`,
          [
            {
              text: 'Allow',
              onPress: () => {
                socket.emit('stream-permission', { viewerId, allowed: true });
                setStreamRequest(null);
              },
            },
            {
              text: 'Deny',
              onPress: () => {
                socket.emit('stream-permission', { viewerId, allowed: false });
                setStreamRequest(null);
              },
            },
          ]
        );
      }
    });

    socket.on('stream-permission', ({ allowed }) => {
      if (allowed) {
        startStreaming();
        setHasRequestedStream(false);
      } else {
        Alert.alert('Request Denied', 'Streaming request declined by host.');
        setHasRequestedStream(false);
      }
    });

    socket.on('chat-message', ({ senderId, message }) => {
      setChatMessages(prev => [...prev, { id: Date.now(), senderId, message }]);
      chatScrollRef.current?.scrollToEnd({ animated: true });
    });

    socket.on('reaction', ({ senderId, type }) => {
      setReactions(prev => [...prev, { id: Date.now(), senderId, type }]);
      Animated.sequence([
        Animated.timing(reactionAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
        Animated.timing(reactionAnim, { toValue: 0, duration: 500, useNativeDriver: true }),
      ]).start(() => {
        setReactions(prev => prev.filter(r => r.id !== Date.now()));
      });
    });

    const statsInterval = setInterval(() => {
      if (isStreaming) {
        setStreamStats(prev => ({ ...prev, duration: prev.duration + 1 }));
      }
    }, 1000);

    return () => {
      socket.removeAllListeners();
      clearInterval(statsInterval);
    };
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

  const requestStreamPermission = () => {
    socket.emit('stream-request', { roomId, viewerId: socket.id });
    setHasRequestedStream(true);
  };

  const startStreaming = async () => {
    try {
      await requestPermissions();
      const stream = await mediaDevices.getUserMedia({
        video: { width: streamQuality === '720p' ? 1280 : 640, height: streamQuality === '720p' ? 720 : 360 },
        audio: true,
      });
      setLocalStream(stream);
      localStreamRef.current = stream;

      peerConnectionRef.current = new RTCPeerConnection(iceServers);
      stream.getTracks().forEach(track => {
        peerConnectionRef.current.addTrack(track, stream);
      });

      peerConnectionRef.current.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', { target: hostId, candidate: event.candidate });
        }
      };

      if (isHost) {
        socket.emit('host-streaming', roomId);
      } else {
        socket.emit('user-started-streaming', { roomId, streamerId: socket.id });
      }
      setIsStreaming(true);
    } catch (err) {
      console.error('Streaming error:', err);
      setError('Failed to start streaming.');
      setHasRequestedStream(false);
    }
  };

  const stopStreaming = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }
    setIsStreaming(false);
    socket.emit('stop-streaming', roomId);
  };

  const leaveRoom = () => {
    socket.emit('leave-room');
    setJoined(false);
    setIsHost(false);
    setIsStreaming(false);
    setViewers([]);
    setViewerList([]);
    setApprovedStreamers([]);
    setRemoteStreams([]);
    setRoomId('');
    setHostId('');
    setHasRequestedStream(false);
    setChatMessages([]);
    setReactions([]);
    setStreamStats({ duration: 0, peakViewers: 0 });

    localStream?.getTracks().forEach(track => track.stop());
    remoteStreams.forEach(s => s.stream.getTracks().forEach(track => track.stop()));
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

  const sendChatMessage = () => {
    if (chatInput.trim() === '') return;
    socket.emit('chat-message', { roomId, message: chatInput });
    setChatInput('');
  };

  const sendReaction = (type) => {
    socket.emit('reaction', { roomId, type });
  };

  const changeStreamQuality = (quality) => {
    setStreamQuality(quality);
    if (isStreaming) {
      stopStreaming();
      setTimeout(startStreaming, 500);
    }
  };

  const renderChatMessage = ({ item }) => (
    <View style={styles(theme).chatMessage}>
      <Text style={styles(theme).chatSender}>{item.senderId}: </Text>
      <Text style={styles(theme).chatText}>{item.message}</Text>
    </View>
  );

  const renderViewer = ({ item }) => (
    <View style={styles(theme).viewerItem}>
      <Text style={styles(theme).viewerText}>{item}</Text>
    </View>
  );

  const renderStream = ({ item }) => (
    <View style={styles(theme).streamItem}>
      <RTCView
        streamURL={item.stream.toURL()}
        style={styles(theme).streamVideo}
        objectFit="cover"
        mirror={true}
      />
      <Text style={styles(theme).streamerId}>{item.id}</Text>
    </View>
  );

  return (
    <View style={styles(theme).container}>
      {!joined ? (
        <View style={styles(theme).joinContainer}>
          <Text style={styles(theme).title}>LiveStream</Text>
          <TextInput
            placeholder="Enter Room ID"
            placeholderTextColor={theme === 'dark' ? '#888' : '#666'}
            value={roomId}
            onChangeText={setRoomId}
            style={styles(theme).input}
          />
          {loading ? (
            <ActivityIndicator size="large" color="#ff2d55" style={styles(theme).loader} />
          ) : (
            <View style={styles(theme).buttonContainer}>
              <TouchableOpacity style={styles(theme).button} onPress={createRoom}>
                <Text style={styles(theme).buttonText}>Create Room</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles(theme).button} onPress={joinRoom}>
                <Text style={styles(theme).buttonText}>Join Room</Text>
              </TouchableOpacity>
            </View>
          )}
          <TouchableOpacity style={styles(theme).themeButton} onPress={toggleTheme}>
            <Icon
              name={theme === 'dark' ? 'brightness-7' : 'brightness-4'}
              size={24}
              color={theme === 'dark' ? '#fff' : '#000'}
            />
          </TouchableOpacity>
          {error ? <Text style={styles(theme).error}>{error}</Text> : null}
        </View>
      ) : (
        <View style={styles(theme).streamContainer}>
          <View style={styles(theme).videoContainer}>
            {isHost && localStream ? (
              <RTCView
                streamURL={localStream.toURL()}
                style={styles(theme).video}
                objectFit="cover"
                mirror={isFrontCamera}
              />
            ) : remoteStreams.find(s => s.id === hostId) ? (
              <RTCView
                streamURL={remoteStreams.find(s => s.id === hostId).stream.toURL()}
                style={styles(theme).video}
                objectFit="cover"
                mirror={true}
              />
            ) : (
              <View style={styles(theme).videoPlaceholder}>
                <Text style={styles(theme).placeholderText}>
                  {isStreaming ? 'Waiting for host stream...' : 'No stream active'}
                </Text>
              </View>
            )}
            <View style={styles(theme).overlay}>
              <View style={styles(theme).topBar}>
                <Text style={styles(theme).roomInfo}>Room: {roomId}</Text>
                <Text style={styles(theme).viewerCount}>👥 {viewerCount}</Text>
              </View>
              {reactions.map(reaction => (
                <Animated.Text
                  key={reaction.id}
                  style={[
                    styles(theme).reaction,
                    { transform: [{ translateY: reactionAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -50] }) }] },
                  ]}
                >
                  {reaction.type === 'like' ? '👍' : '❤️'}
                </Animated.Text>
              ))}
            </View>
          </View>

          <View style={styles(theme).contentContainer}>
            {isHost ? (
              <View style={styles(theme).hostControls}>
                <View style={styles(theme).controlRow}>
                  <TouchableOpacity style={styles(theme).controlButton} onPress={toggleMute}>
                    <Icon name={isMuted ? 'mic-off' : 'mic'} size={24} color={theme === 'dark' ? '#fff' : '#000'} />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles(theme).controlButton} onPress={switchCamera}>
                    <Icon name="flip-camera-ios" size={24} color={theme === 'dark' ? '#fff' : '#000'} />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles(theme).controlButton} onPress={toggleTheme}>
                    <Icon
                      name={theme === 'dark' ? 'brightness-7' : 'brightness-4'}
                      size={24}
                      color={theme === 'dark' ? '#fff' : '#000'}
                    />
                  </TouchableOpacity>
                </View>
                <View style={styles(theme).streamButtons}>
                  {!isStreaming ? (
                    <TouchableOpacity style={styles(theme).actionButton} onPress={startStreaming}>
                      <Text style={styles(theme).buttonText}>Start Stream</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity style={[styles(theme).actionButton, styles(theme).stopButton]} onPress={stopStreaming}>
                      <Text style={styles(theme).buttonText}>Stop Stream</Text>
                    </TouchableOpacity>
                  )}
                </View>
                <View style={styles(theme).statsContainer}>
                  <Text style={styles(theme).statsText}>
                    Duration: {Math.floor(streamStats.duration / 60)}:{(streamStats.duration % 60).toString().padStart(2, '0')}
                  </Text>
                  <Text style={styles(theme).statsText}>Peak Viewers: {streamStats.peakViewers}</Text>
                </View>
              </View>
            ) : (
              <View style={styles(theme).viewerControls}>
                <TouchableOpacity
                  style={[styles(theme).actionButton, hasRequestedStream && styles(theme).disabledButton]}
                  onPress={requestStreamPermission}
                  disabled={hasRequestedStream}
                >
                  <Text style={styles(theme).buttonText}>
                    {hasRequestedStream ? 'Awaiting Permission...' : 'Request to Stream'}
                  </Text>
                </TouchableOpacity>
                {localStream && (
                  <View style={styles(theme).controlRow}>
                    <TouchableOpacity style={styles(theme).controlButton} onPress={toggleMute}>
                      <Icon name={isMuted ? 'mic-off' : 'mic'} size={24} color={theme === 'dark' ? '#fff' : '#000'} />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles(theme).controlButton} onPress={switchCamera}>
                      <Icon name="flip-camera-ios" size={24} color={theme === 'dark' ? '#fff' : '#000'} />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles(theme).controlButton} onPress={toggleTheme}>
                      <Icon
                        name={theme === 'dark' ? 'brightness-7' : 'brightness-4'}
                        size={24}
                        color={theme === 'dark' ? '#fff' : '#000'}
                      />
                    </TouchableOpacity>
                  </View>
                )}
                {isStreaming && localStream && (
                  <View style={styles(theme).qualitySelector}>
                    <Text style={styles(theme).qualityLabel}>Quality:</Text>
                    {['720p', '480p'].map(quality => (
                      <TouchableOpacity
                        key={quality}
                        style={[styles(theme).qualityButton, streamQuality === quality && styles(theme).qualityButtonActive]}
                        onPress={() => changeStreamQuality(quality)}
                      >
                        <Text style={styles(theme).buttonText}>{quality}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            )}

            <View style={styles(theme).chatContainer}>
              <FlatList
                ref={chatScrollRef}
                data={chatMessages}
                renderItem={renderChatMessage}
                keyExtractor={item => item.id.toString()}
                style={styles(theme).chatList}
              />
              <View style={styles(theme).chatInputContainer}>
                <TextInput
                  placeholder="Type a message..."
                  placeholderTextColor={theme === 'dark' ? '#888' : '#666'}
                  value={chatInput}
                  onChangeText={setChatInput}
                  style={styles(theme).chatInput}
                />
                <TouchableOpacity style={styles(theme).sendButton} onPress={sendChatMessage}>
                  <Icon name="send" size={24} color="#ff2d55" />
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles(theme).viewerListContainer}>
              <Text style={styles(theme).sectionTitle}>Viewers</Text>
              <FlatList
                data={viewerList}
                renderItem={renderViewer}
                keyExtractor={item => item}
                style={styles(theme).viewerList}
              />
            </View>

            {approvedStreamers.length > 0 && (
              <View style={styles(theme).streamsContainer}>
                <Text style={styles(theme).sectionTitle}>Users' Stream Video</Text>
                <FlatList
                  data={remoteStreams.filter(s => s.id !== hostId)}
                  renderItem={renderStream}
                  keyExtractor={item => item.id}
                  horizontal
                  style={styles(theme).streamsList}
                />
              </View>
            )}

            {isStreaming && (
              <View style={styles(theme).reactionContainer}>
                <TouchableOpacity style={styles(theme).reactionButton} onPress={() => sendReaction('like')}>
                  <Text style={styles(theme).reactionText}>👍</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles(theme).reactionButton} onPress={() => sendReaction('heart')}>
                  <Text style={styles(theme).reactionText}>❤️</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          <TouchableOpacity style={styles(theme).leaveButton} onPress={leaveRoom}>
            <Text style={styles(theme).buttonText}>Leave Room</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
};

const styles = (theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme === 'dark' ? '#121212' : '#f5f5f5',
    },
    joinContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 20,
    },
    streamContainer: {
      flex: 1,
    },
    title: {
      fontSize: 32,
      fontWeight: 'bold',
      color: theme === 'dark' ? '#ff2d55' : '#d81b60',
      marginBottom: 40,
      textAlign: 'center',
    },
    input: {
      backgroundColor: theme === 'dark' ? '#1e1e1e' : '#ffffff',
      color: theme === 'dark' ? '#fff' : '#000',
      borderRadius: 12,
      padding: 15,
      width: '80%',
      marginBottom: 20,
      fontSize: 16,
      borderWidth: 1,
      borderColor: theme === 'dark' ? '#333' : '#ccc',
    },
    buttonContainer: {
      width: '80%',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    button: {
      backgroundColor: '#ff2d55',
      paddingVertical: 15,
      paddingHorizontal: 20,
      borderRadius: 12,
      flex: 1,
      marginHorizontal: 5,
      alignItems: 'center',
    },
    buttonText: {
      color: '#fff',
      fontSize: 16,
      fontWeight: '600',
    },
    themeButton: {
      marginTop: 20,
      padding: 10,
      backgroundColor: theme === 'dark' ? '#1e1e1e' : '#e0e0e0',
      borderRadius: 12,
    },
    loader: {
      marginVertical: 20,
    },
    error: {
      color: theme === 'dark' ? '#ff6b6b' : '#d32f2f',
      marginTop: 20,
      fontSize: 14,
      textAlign: 'center',
    },
    videoContainer: {
      width: '100%',
      height: height * 0.4,
      backgroundColor: '#000',
      borderBottomLeftRadius: 20,
      borderBottomRightRadius: 20,
      overflow: 'hidden',
      position: 'relative',
    },
    video: {
      width: '100%',
      height: '100%',
    },
    videoPlaceholder: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: theme === 'dark' ? '#1e1e1e' : '#e0e0e0',
    },
    placeholderText: {
      color: theme === 'dark' ? '#888' : '#666',
      fontSize: 16,
    },
    overlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      padding: 10,
    },
    topBar: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: theme === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)',
      borderRadius: 8,
      padding: 8,
    },
    roomInfo: {
      color: theme === 'dark' ? '#fff' : '#000',
      fontSize: 14,
      fontWeight: '600',
    },
    viewerCount: {
      color: theme === 'dark' ? '#fff' : '#000',
      fontSize: 14,
      fontWeight: '600',
    },
    contentContainer: {
      flex: 1,
      padding: 15,
    },
    hostControls: {
      marginBottom: 15,
    },
    viewerControls: {
      marginBottom: 15,
    },
    controlRow: {
      flexDirection: 'row',
      justifyContent: 'center',
      marginVertical: 10,
    },
    controlButton: {
      backgroundColor: theme === 'dark' ? '#1e1e1e' : '#e0e0e0',
      padding: 12,
      borderRadius: 12,
      marginHorizontal: 10,
    },
    streamButtons: {
      flexDirection: 'row',
      justifyContent: 'center',
    },
    actionButton: {
      backgroundColor: '#ff2d55',
      paddingVertical: 12,
      paddingHorizontal: 20,
      borderRadius: 12,
      alignItems: 'center',
      marginHorizontal: 5,
      flex: 1,
    },
    stopButton: {
      backgroundColor: '#ff6b6b',
    },
    disabledButton: {
      backgroundColor: theme === 'dark' ? '#555' : '#b0b0b0',
    },
    statsContainer: {
      marginTop: 10,
      alignItems: 'center',
    },
    statsText: {
      color: theme === 'dark' ? '#fff' : '#000',
      fontSize: 14,
    },
    qualitySelector: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      marginVertical: 10,
    },
    qualityLabel: {
      color: theme === 'dark' ? '#fff' : '#000',
      fontSize: 14,
      marginRight: 10,
    },
    qualityButton: {
      backgroundColor: theme === 'dark' ? '#1e1e1e' : '#e0e0e0',
      paddingVertical: 8,
      paddingHorizontal: 15,
      borderRadius: 8,
      marginHorizontal: 5,
    },
    qualityButtonActive: {
      backgroundColor: '#ff2d55',
    },
    chatContainer: {
      flex: 1,
      backgroundColor: theme === 'dark' ? '#1e1e1e' : '#ffffff',
      borderRadius: 12,
      padding: 10,
      marginBottom: 15,
      borderWidth: 1,
      borderColor: theme === 'dark' ? '#333' : '#ccc',
    },
    chatList: {
      flex: 1,
    },
    chatMessage: {
      flexDirection: 'row',
      marginVertical: 5,
    },
    chatSender: {
      color: '#ff2d55',
      fontWeight: '600',
      fontSize: 14,
    },
    chatText: {
      color: theme === 'dark' ? '#fff' : '#000',
      fontSize: 14,
      flex: 1,
    },
    chatInputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 10,
    },
    chatInput: {
      flex: 1,
      backgroundColor: theme === 'dark' ? '#2c2c2c' : '#f0f0f0',
      color: theme === 'dark' ? '#fff' : '#000',
      borderRadius: 12,
      padding: 10,
      fontSize: 14,
    },
    sendButton: {
      padding: 10,
    },
    viewerListContainer: {
      backgroundColor: theme === 'dark' ? '#1e1e1e' : '#ffffff',
      borderRadius: 12,
      padding: 10,
      marginBottom: 15,
      borderWidth: 1,
      borderColor: theme === 'dark' ? '#333' : '#ccc',
    },
    sectionTitle: {
      color: theme === 'dark' ? '#fff' : '#000',
      fontSize: 16,
      fontWeight: '600',
      marginBottom: 10,
    },
    viewerList: {
      maxHeight: 100,
    },
    viewerItem: {
      paddingVertical: 5,
    },
    viewerText: {
      color: theme === 'dark' ? '#fff' : '#000',
      fontSize: 14,
    },
    streamsContainer: {
      backgroundColor: theme === 'dark' ? '#1e1e1e' : '#ffffff',
      borderRadius: 12,
      padding: 10,
      marginBottom: 15,
      borderWidth: 1,
      borderColor: theme === 'dark' ? '#333' : '#ccc',
    },
    streamsList: {
      maxHeight: 100,
    },
    streamItem: {
      width: 120,
      marginRight: 10,
      alignItems: 'center',
    },
    streamVideo: {
      width: 100,
      height: 60,
      borderRadius: 8,
    },
    streamerId: {
      color: theme === 'dark' ? '#fff' : '#000',
      fontSize: 12,
      marginTop: 5,
    },
    reactionContainer: {
      flexDirection: 'row',
      justifyContent: 'center',
      marginBottom: 15,
    },
    reactionButton: {
      backgroundColor: theme === 'dark' ? '#1e1e1e' : '#e0e0e0',
      padding: 12,
      borderRadius: 12,
      marginHorizontal: 10,
    },
    reactionText: {
      fontSize: 24,
    },
    reaction: {
      position: 'absolute',
      right: 20,
      bottom: 20,
      fontSize: 30,
      color: theme === 'dark' ? '#fff' : '#000',
    },
    leaveButton: {
      backgroundColor: '#ff6b6b',
      paddingVertical: 15,
      borderRadius: 12,
      alignItems: 'center',
      margin: 15,
    },
  });

const AppWrapper = () => (
  <ThemeProvider>
    <App />
  </ThemeProvider>
);

export default AppWrapper;