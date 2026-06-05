---
layout: post
title: "React Native for Cross-Platform Mobile Development"
date: 2018-05-21
categories: [How-To]
tags: [React Native, Mobile, Cross-Platform, JavaScript]
excerpt: "We had two developers, two app stores, and a deadline that assumed we had four developers. React Native didn't make mobile easy—it made mobile possible."
---

The pitch was simple: one codebase, two app stores, native performance. The reality, as we learned shipping our first React Native app, was more like one codebase, two app stores, three build systems, and a growing collection of `Platform.OS` conditionals.

But here's the thing—it worked. We shipped to iOS and Android in the time it would have taken to ship one platform natively. The app wasn't perfect. The Android version had a slightly different shadow rendering. The iOS version crashed once on a specific iPhone SE rotation. Users downloaded it, used it, and mostly didn't notice we were running JavaScript under the hood.

React Native isn't "write once, run anywhere." It's "learn once, write anywhere"—which is a more honest and more useful promise. You write React components, they render to native UI elements, and you accept that sometimes you'll need platform-specific code. That's the deal, and for many teams, it's a good one.

## Why We Chose React Native (And When You Should Too)

The benefits that actually mattered in production:

- **One language for web and mobile.** Our team already knew React. The ramp-up was weeks, not months.
- **Native components, not WebViews.** React Native renders to real `UIView` and `android.view` elements. Performance is genuinely good for most app categories—not game-quality, but solid for business and consumer apps.
- **Fast iteration.** Hot reload means you see changes in seconds. Native rebuild cycles are measured in minutes. That difference compounds over a project.
- **NPM ecosystem.** Most JavaScript libraries work. Some don't. But the ones that do save enormous time.

What React Native is not: a replacement for native development when you need bleeding-edge platform features, complex animations, or maximum performance. Know your app's requirements before you commit.

## Getting Started: CLI vs. Expo

```bash
# Install React Native CLI
npm install -g react-native-cli

# Create new project
react-native init MyApp

# Or use Expo (easier onboarding, fewer native headaches)
npm install -g expo-cli
expo init MyApp
```

We started with Expo and never looked back for our first two apps. Expo handles the native build toolchain, provides a solid set of APIs (camera, notifications, file system), and lets you test on a real device with a QR code scan. The tradeoff: you're in Expo's ecosystem until you eject.

Eject when you need a native module Expo doesn't support. Don't eject preemptively because you might need it someday—that's how you end up maintaining Gradle files at midnight.

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

Keep platform-specific code in `android/` and `ios/`. Keep shared logic in `src/`. The moment you start sprinkling Java into your JavaScript files, you've lost the plot.

## Your First Component

React Native uses React's component model but replaces HTML elements with native primitives:

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

`View` is your `div`. `Text` is your `p`/`span` (and yes, all text must be wrapped in `<Text>`—this trips up every web developer exactly once). `StyleSheet.create` is like CSS but with camelCase and flexbox as the default layout engine.

Flexbox is the layout system. Not optional. Not "one of several options." Learn flexbox if you haven't, because every screen you build will use it.

## Navigation: Getting Between Screens

React Navigation was the clear winner in 2018 and remains the standard:

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

Stack navigators for drill-down flows. Tab navigators for top-level sections. Nest them as needed. The navigation state is a tree, and your component hierarchy should mirror it.

## State Management: Keep It Boring

For most apps, React's built-in state plus Context is enough. When it's not, Redux Toolkit (then relatively new) provided a sane default:

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

Don't reach for Redux on day one. Start with `useState` and `useContext`. Add Redux when you have shared state that multiple distant components need to read and write. Premature Redux is how you end up dispatching an action to toggle a modal.

## API Integration: Talking to Your Backend

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

`fetch` works out of the box. `AsyncStorage` replaces `localStorage` (which doesn't exist in React Native). Wrap your API calls in a service class so you're not duplicating auth header logic in every screen.

Handle network errors gracefully. Mobile users lose connectivity constantly—tunnels, elevators, spotty WiFi. Your app should degrade with dignity, not crash with a stack trace.

## Native Modules: When JavaScript Isn't Enough

Sometimes you need platform-specific functionality that React Native doesn't ship with—biometrics, proprietary SDKs, hardware access. That's what native modules are for.

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

Before writing a native module, check if one already exists on NPM. The React Native community has modules for camera, maps, push notifications, SQLite, and hundreds of other capabilities. Writing your own is a last resort, not a first instinct.

## Performance: Where Apps Live or Die

Mobile users are ruthless. A sluggish scroll or a frozen screen and your app gets uninstalled with the conviction of someone ending a bad relationship.

### FlatList, Not ScrollView

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

`ScrollView` renders every child at once. For 20 items, fine. For 200, your app will stutter like it's thinking about a question it doesn't want to answer. `FlatList` virtualizes—only rendering items visible on screen. Use it for any list longer than a dozen items.

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

`memo` prevents re-renders when props haven't changed. `useMemo` caches expensive computations. Don't memo everything—that adds overhead. Profile first, optimize what actually hurts.

### Images

```javascript
import { Image } from 'react-native';

<Image
    source={{ uri: imageUrl }}
    style={styles.image}
    resizeMode="cover"
/>
```

Resize images server-side. A 4000×3000 photo rendered in a 80×80 avatar slot is waste—bandwidth waste, memory waste, and battery waste. Use a CDN with image transforms if you can.

## Platform-Specific Code: The Inevitable Compromise

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

Some differences are cosmetic (padding, shadows). Some are structural (Android back button behavior, iOS safe areas). `Platform.select` keeps the branching clean. For bigger differences, separate component files are clearer than inline conditionals.

Accept that your app will look slightly different on each platform. Users expect that. An iOS app that looks exactly like its Android counterpart feels wrong on both platforms.

## Testing: Simulators Lie

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

Unit tests catch logic bugs. They don't catch "the keyboard covers the submit button on iPhone SE" or "the RecyclerView stutters on a Samsung Galaxy S7." Test on real devices. Borrow coworkers' phones. Keep a drawer of test devices if you can. Simulators are for development; devices are for validation.

## Deployment: The Part Nobody Talks About

### Android

```bash
# Generate release APK
cd android
./gradlew assembleRelease

# Or AAB for Play Store (preferred by Google)
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

Android deployment is Gradle and keystores. iOS deployment is Xcode, provisioning profiles, and certificates. Budget time for both. The build system is not the app, but it will consume your afternoon anyway.

## What We'd Do Differently (And What We'd Do Again)

**TypeScript from the start.** We added it mid-project. The migration was painful. Starting with TypeScript catches an entire category of bugs at compile time—especially prop type mismatches between screens.

**Optimize images early.** We didn't, and then we spent a sprint fixing image-related performance issues that users had been suffering through for months.

**Error boundaries everywhere.** A JavaScript error in one component shouldn't white-screen the entire app. Wrap major sections in error boundaries with a "something went wrong" fallback.

**Test on devices, not just simulators.** Every platform-specific bug we shipped was reproducible on hardware and invisible in the simulator.

**Monitor performance in production.** Flipper and Reactotron are great for development. You also need crash reporting (Crashlytics, Sentry) and performance monitoring in production.

**Lazy-load screens.** Not every screen needs to be in the initial bundle. React Navigation supports lazy loading—use it for infrequently visited screens.

**Keep dependencies updated.** React Native moves fast. Security patches and performance fixes come through dependency updates. Schedule monthly maintenance.

**Native modules as a last resort.** The NPM ecosystem covers most needs. Every native module you write is a module you maintain across platform updates.

## The Bottom Line

React Native gave us a mobile presence with a team that wasn't a mobile team. We shipped faster, shared code between platforms, and delivered an experience users rated well enough to keep using.

It wasn't free. We fought build systems, wrote platform-specific code, and debugged issues that only appeared on specific devices. But the alternative—two native codebases, two teams, or half the platform coverage—was worse for our situation.

Start with Expo if you're new to mobile. Learn flexbox. Use FlatList. Test on real devices. Add complexity only when you need it.

The patterns here carried us through three production apps. React Native has evolved since, but the fundamentals—component model, native rendering, pragmatic platform branching—are the same.

---

*Written in May 2018, covering React Native 0.55+ with React Navigation 3.x and the emerging Redux Toolkit. Expo was at SDK 28; the managed workflow vs. eject debate was as lively as ever.*
