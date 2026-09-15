Pod::Spec.new do |s|
  s.name           = 'ExpoHwKeys'
  s.version        = '1.0.0'
  s.summary        = 'The physical keyboard the phone carries'
  s.description    = 'Intercepts the keys the terminal field does not consume (Esc, Tab, arrows, Home/End, PgUp/Dn, Delete, F-keys, Ctrl/Alt chords, Cmd+V) and hands them to JS as raw events; plain printables, Return, Backspace and Space go on to the field untouched.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '17.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
