---
layout: post
title: "React Native for Cross-Platform Mobile Development"
date: 2018-05-21
categories: [How-To]
tags: [React Native, Mobile, Cross-Platform, JavaScript]
excerpt: "Building cross-platform mobile apps with React Native, covering setup, navigation, native modules, performance optimization, and deployment strategies."
---

React Native enables building iOS and Android apps with one codebase. After shipping multiple React Native apps, here's what works in production.

## Why React Native?

Benefits:
- **Single codebase** - Write once, run on iOS and Android
- **Native performance** - Uses native components
- **Hot reload** - Fast development iteration
- **Large ecosystem** - NPM packages available

## Setup

### Installation

```bash
# Install React Native CLI
npm install -g react-native-cli

# Create new project
react-native init MyApp

# Or use Expo (easier)
npm install -g expo-cli
expo init MyApp
```

### Project Structure

```
MyApp/
├── App.js
├── package.json
├── android/
│   ├── app/
│   └── build.gradle
├── ios/
│   ├── MyApp/
│   └── Podfile
└── src/
    ├── components/
    ├── screens/
    ├── navigation/
    └── services/
```

## Basic Component

```javascript
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export default function App() {
    return (
        <View style={styles.container}>
            <Text style={styles.title}>Hello React Native!</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#F5FCFF'
    },
    title: {
        fontSize: 20,
        fontWeight: 'bold',
        margin: 20
    }
});
```

## Navigation

### React Navigation

```bash
npm install @react-navigation/native
npm install react-native-screens react-native-safe-area-context
npm install @react-navigation/stack
npm install @react-navigation/bottom-tabs
```

```javascript
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

const Stack = createStackNavigator();
const Tab = createBottomTabNavigator();

function HomeStack() {
    return (
        <Stack.Navigator>
            <Stack.Screen name="Home" component={HomeScreen} />
            <Stack.Screen name="Details" component={DetailsScreen} />
        </Stack.Navigator>
    );
}

function App() {
    return (
        <NavigationContainer>
            <Tab.Navigator>
                <Tab.Screen name="Home" component={HomeStack} />
                <Tab.Screen name="Profile" component={ProfileScreen} />
                <Tab.Screen name="Settings" component={SettingsScreen} />
            </Tab.Navigator>
        </NavigationContainer>
    );
}
```

## State Management

### Redux Integration

```bash
npm install redux react-redux
npm install @reduxjs/toolkit
```

```javascript
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import userReducer from './src/redux/userSlice';

const store = configureStore({
    reducer: {
        user: userReducer
    }
});

function App() {
    return (
        <Provider store={store}>
            <NavigationContainer>
                {/* Your app */}
            </NavigationContainer>
        </Provider>
    );
}
```

## API Integration

```javascript
import AsyncStorage from '@react-native-async-storage/async-storage';

class ApiService {
    constructor() {
        this.baseUrl = 'https://api.example.com';
    }
    
    async get(endpoint, headers = {}) {
        const token = await AsyncStorage.getItem('authToken');
        
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                ...headers
            }
        });
        
        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }
        
        return response.json();
    }
    
    async post(endpoint, data, headers = {}) {
        const token = await AsyncStorage.getItem('authToken');
        
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                ...headers
            },
            body: JSON.stringify(data)
        });
        
        return response.json();
    }
}

export default new ApiService();
```

## Native Modules

### Calling Native Code

```javascript
import { NativeModules } from 'react-native';

const { MyNativeModule } = NativeModules;

// Call native method
MyNativeModule.showToast('Hello from native!');
```

### Android Native Module

```java
// MyNativeModule.java
package com.myapp;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import android.widget.Toast;

public class MyNativeModule extends ReactContextBaseJavaModule {
    public MyNativeModule(ReactApplicationContext reactContext) {
        super(reactContext);
    }
    
    @Override
    public String getName() {
        return "MyNativeModule";
    }
    
    @ReactMethod
    public void showToast(String message) {
        Toast.makeText(getReactApplicationContext(), message, Toast.LENGTH_SHORT).show();
    }
}
```

### iOS Native Module

```objective-c
// MyNativeModule.m
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(MyNativeModule, NSObject)

RCT_EXTERN_METHOD(showToast:(NSString *)message)

@end
```

## Performance Optimization

### FlatList for Lists

```javascript
import { FlatList } from 'react-native';

function UserList({ users }) {
    return (
        <FlatList
            data={users}
            keyExtractor={item => item.id.toString()}
            renderItem={({ item }) => <UserItem user={item} />}
            initialNumToRender={10}
            maxToRenderPerBatch={10}
            windowSize={10}
            removeClippedSubviews={true}
        />
    );
}
```

### Memoization

```javascript
import React, { memo, useMemo } from 'react';

const UserItem = memo(({ user }) => {
    const formattedDate = useMemo(
        () => formatDate(user.createdAt),
        [user.createdAt]
    );
    
    return (
        <View>
            <Text>{user.name}</Text>
            <Text>{formattedDate}</Text>
        </View>
    );
});
```

### Image Optimization

```javascript
import { Image } from 'react-native';

<Image
    source={{ uri: imageUrl }}
    style={styles.image}
    resizeMode="cover"
    // Use cached images
    cache="force-cache"
/>
```

## Platform-Specific Code

```javascript
import { Platform } from 'react-native';

const styles = StyleSheet.create({
    container: {
        paddingTop: Platform.OS === 'ios' ? 20 : 0,
        ...Platform.select({
            ios: {
                backgroundColor: '#F5F5F5'
            },
            android: {
                backgroundColor: '#FFFFFF'
            }
        })
    }
});

// Platform-specific components
const Button = Platform.select({
    ios: () => require('./ButtonIOS').default,
    android: () => require('./ButtonAndroid').default
})();
```

## Testing

```javascript
import { render, fireEvent } from '@testing-library/react-native';
import LoginScreen from './LoginScreen';

test('login button works', () => {
    const { getByText, getByPlaceholderText } = render(<LoginScreen />);
    
    const emailInput = getByPlaceholderText('Email');
    const passwordInput = getByPlaceholderText('Password');
    const loginButton = getByText('Login');
    
    fireEvent.changeText(emailInput, 'user@example.com');
    fireEvent.changeText(passwordInput, 'password123');
    fireEvent.press(loginButton);
    
    // Assertions
});
```

## Deployment

### Android

```bash
# Generate release APK
cd android
./gradlew assembleRelease

# Or AAB for Play Store
./gradlew bundleRelease
```

### iOS

```bash
# Build for release
cd ios
pod install
xcodebuild -workspace MyApp.xcworkspace \
    -scheme MyApp \
    -configuration Release \
    -archivePath build/MyApp.xcarchive \
    archive
```

## Best Practices

1. **Use TypeScript** - Catch errors early
2. **Optimize images** - Compress and resize
3. **Handle errors** - Error boundaries
4. **Test on devices** - Not just simulators
5. **Monitor performance** - Use Flipper/Reactotron
6. **Code splitting** - Lazy load screens
7. **Use native modules** - When needed
8. **Keep dependencies updated** - Security patches

## Conclusion

React Native enables:
- Cross-platform development
- Code reuse
- Native performance
- Fast iteration

Start with Expo for easier setup, then eject if you need native modules. The patterns shown here work for production apps.

---

*React Native patterns from May 2018, covering React Native 0.55+ features.*
